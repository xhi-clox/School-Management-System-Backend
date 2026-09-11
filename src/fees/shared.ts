import { Prisma } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

export const money = (v: any): Prisma.Decimal => new Prisma.Decimal(v ?? 0);
export const roundMoney = (v: any): Prisma.Decimal => money(v).toDecimalPlaces(2);
export const toNumber = (v: any): number => money(v).toNumber();

export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'bkash', 'nagad', 'card', 'cheque'] as const;

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const isVoided = (p: { status?: string | null }): boolean =>
  p.status != null && String(p.status).toLowerCase() === 'voided';

export const netPaid = (payments?: Array<{ amount: any }>): Prisma.Decimal =>
  (payments ?? []).filter((p: any) => !isVoided(p)).reduce((s, p) => s.plus(money(p.amount)), money(0));

export const invoiceBalance = (inv: { totalAmount: any }, payments?: Array<{ amount: any }>): Prisma.Decimal =>
  money(inv.totalAmount).minus(netPaid(payments));

/** Derived collection/aging state — NEVER persisted. status tells payment state, this tells aging. */
export type FeeState = 'PAID' | 'DUE' | 'OVERDUE';

export const getFeeState = (
  balance: any,
  dueDate?: Date | string | null,
  today: Date = new Date(),
): FeeState => {
  if (money(balance).lte(0)) return 'PAID';
  if (!dueDate) return 'DUE';
  const due = dueDate instanceof Date ? dueDate : new Date(dueDate);
  return startOfDay(due) < startOfDay(today) ? 'OVERDUE' : 'DUE';
};

/** BD academic year starts in July: Aug 2026 -> '2026-27', Jan 2026 -> '2025-26'. */
export const academicYearForMonth = (year: number, month: number): string =>
  month >= 7
    ? `${year}-${String((year + 1) % 100).padStart(2, '0')}`
    : `${String((year - 1) % 100).padStart(2, '0')}-${String(year % 100).padStart(2, '0')}`;

export const academicYearForDate = (d: Date): string =>
  academicYearForMonth(d.getFullYear(), d.getMonth() + 1);

export const billingMonthStr = (year: number, month: number): string =>
  `${year}-${String(month).padStart(2, '0')}`;

export const parseBillingMonth = (value: string): { year: number; month: number } | null => {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
};

/**
 * Tuition resolution precedence:
 *   customAmount  >  discountPercent  >  FeeStructure.amount
 */
export const computeTuition = (
  baseAmount: any,
  customAmount?: any,
  discountPercent: number | null | undefined = 0,
): Prisma.Decimal => {
  if (customAmount != null && money(customAmount).gt(0)) return roundMoney(customAmount);
  const base = money(baseAmount);
  if (!base.gt(0)) return base;
  const pct = Number(discountPercent ?? 0);
  if (pct <= 0) return roundMoney(base);
  return base.times(1 - pct / 100).toDecimalPlaces(2);
};

const isAssignedApplicable = (
  a: { startMonth: number; startYear: number; endMonth?: number | null; endYear?: number | null },
  year: number,
  month: number,
): boolean => {
  const startsOk = a.startYear < year || (a.startYear === year && a.startMonth <= month);
  const endsOk = !a.endYear || a.endYear > year || (a.endYear === year && (!a.endMonth || a.endMonth >= month));
  return startsOk && endsOk;
};

export interface FeeStructureLike {
  id: string;
  amount: any;
  frequency?: string | null;
  isActive?: boolean;
  classId?: string | null;
  class?: { name: string; section: string } | null;
}

export interface AssignmentLike {
  id: string;
  studentId: string;
  discountPercent: number;
  customAmount?: any;
  startMonth: number;
  startYear: number;
  endMonth?: number | null;
  endYear?: number | null;
  feeStructure?: { amount: any } | null;
}

/** Best monthly fee structure for a student's class/section; prefers exact, falls back to global. */
export const findStructureForClass = (
  structures: FeeStructureLike[],
  className: string,
  section: string,
): FeeStructureLike | null => {
  const active = structures.filter((s) => s.isActive !== false && (!s.frequency || s.frequency === 'monthly'));
  const exact = active.find((s) => s.class && s.class.name === className && s.class.section === section);
  if (exact) return exact;
  const classOnly = active.find((s) => s.class && s.class.name === className && !s.classId);
  if (classOnly) return classOnly;
  return active.find((s) => !s.class && !s.classId) ?? null;
};

export interface TuitionResolution {
  finalAmount: Prisma.Decimal | null;
  reason: 'OK' | 'NO_STRUCTURE';
  base: Prisma.Decimal | null;
  customAmount: Prisma.Decimal | null;
  discountPercent: number;
  structureId: string | null;
  assignmentId: string | null;
}

export const resolveStudentTuition = (
  student: { id: string; class: string; section: string },
  structures: FeeStructureLike[],
  assignments: AssignmentLike[],
  year: number,
  month: number,
): TuitionResolution => {
  const structure = findStructureForClass(structures, student.class, student.section);
  const assignment = assignments.find(
    (a) => a.studentId === student.id && isAssignedApplicable(a, year, month),
  );

  const hasBase = !!structure || !!assignment?.feeStructure;
  if (!hasBase) {
    return {
      finalAmount: null,
      reason: 'NO_STRUCTURE',
      base: null,
      customAmount: null,
      discountPercent: 0,
      structureId: null,
      assignmentId: null,
    };
  }

  const customAmount = assignment?.customAmount != null ? money(assignment.customAmount) : null;
  const discountPercent = assignment ? Number(assignment.discountPercent ?? 0) : 0;
  const base = money(
    assignment ? (assignment.feeStructure?.amount ?? structure?.amount ?? 0) : structure!.amount,
  );
  const finalAmount = computeTuition(base, customAmount, discountPercent);

  return {
    finalAmount,
    reason: 'OK',
    base,
    customAmount,
    discountPercent,
    structureId: structure?.id ?? (assignment?.feeStructure as { id?: string } | null)?.id ?? null,
    assignmentId: assignment?.id ?? null,
  };
};

export const nextInvoiceNumber = async (
  tx: Tx,
  academicYear: string,
): Promise<{ invoiceNo: string; seq: number }> => {
  const scope = `invoice-${academicYear}`;
  const seq = await tx.numberSequence.upsert({
    where: { scope },
    update: { last: { increment: 1 } },
    create: { scope, last: 1 },
  });
  return { invoiceNo: `INV-${academicYear}-${String(seq.last).padStart(5, '0')}`, seq: seq.last };
};

export const nextPaymentNumber = async (
  tx: Tx,
  academicYear: string,
): Promise<{ paymentNo: string; seq: number }> => {
  const scope = `payment-${academicYear}`;
  const seq = await tx.numberSequence.upsert({
    where: { scope },
    update: { last: { increment: 1 } },
    create: { scope, last: 1 },
  });
  return { paymentNo: `REC-${academicYear}-${String(seq.last).padStart(5, '0')}`, seq: seq.last };
};

/** Row lock on an invoice via SELECT ... FOR UPDATE. Throws 'Invoice not found'. */
export const lockInvoice = async (tx: Tx, invoiceId: string): Promise<void> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`,
  );
  if (!rows.length) throw new Error('Invoice not found');
};

/**
 * THE single writer of paidAmount/status. Recomputes from active (non-voided) payments.
 * Always passes running totals the amount is recomputed — never stored as an offset.
 */
export const recalcInvoiceTx = async (tx: Tx, invoiceId: string) => {
  const rows = await tx.$queryRaw<Array<{ total: string | number }>>(
    Prisma.sql`SELECT COALESCE(SUM(amount), 0) AS total FROM "Payment" WHERE "invoiceId" = ${invoiceId} AND (status IS NULL OR status = 'active')`,
  );
  const total = money(rows[0]?.total ?? 0);
  const inv = await tx.invoice.findUnique({
    where: { id: invoiceId },
    select: { totalAmount: true },
  });
  const status = total.gte(money(inv?.totalAmount ?? 0)) ? 'paid' : total.gt(0) ? 'partial' : 'unpaid';
  return tx.invoice.update({
    where: { id: invoiceId },
    data: { paidAmount: total.toDecimalPlaces(2), status },
  });
};

export const logAudit = async (
  tx: Tx,
  entry: { action: string; entity?: string; entityId?: string; actor?: string; reason?: string; meta?: any },
): Promise<void> => {
  await tx.auditLog.create({
    data: {
      action: entry.action,
      entity: entry.entity ?? null,
      entityId: entry.entityId ?? null,
      actor: entry.actor ?? null,
      reason: entry.reason ?? null,
      meta: entry.meta ?? undefined,
    },
  });
};