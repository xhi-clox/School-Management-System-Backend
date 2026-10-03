import { Prisma, PrismaClient } from '@prisma/client';
import { academicYearForMonth, money, nextInvoiceNumber, roundMoney } from './shared';
import type { Tx } from './shared';

/**
 * Single source of truth for the category-driven fee system.
 *
 * Both "Add Fee Record" (manual) and "Generate Monthly Fees" (bulk) call the
 * functions in this module, so category validation, class-assignment lookup,
 * amount resolution, duplicate detection and ledger integration can never drift
 * apart between the two entry points.
 */

export type Db = PrismaClient | Prisma.TransactionClient;

export class FeeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FeeError';
  }
}

/** Billing period is YYYY-MM today; the shape stays string-based so term periods can be added later. */
export const BILLING_PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const ADMISSION_PERIOD_RE = /^(\d{4})-ADM$/;

export function assertBillingPeriod(period: string): string {
  if (!BILLING_PERIOD_RE.test(period) && !ADMISSION_PERIOD_RE.test(period)) {
    throw new FeeError(400, `Invalid billing period "${period}". Expected YYYY-MM (e.g. 2026-10).`);
  }
  return period;
}

export type DiscountType = 'percentage' | 'fixed' | null;

export interface AmountInput {
  /** Amount from the class/category assignment. */
  assignmentAmount: Prisma.Decimal;
  /** Explicit per-record override supplied by an authorised admin. */
  manualOverride?: Prisma.Decimal | null;
  /** Explicit discount supplied by an authorised admin. */
  manualDiscountType?: DiscountType;
  manualDiscountValue?: Prisma.Decimal | null;
  /** Active StudentFeeOverride (period-specific or standing). */
  override?: {
    overrideAmount: Prisma.Decimal | null;
    overrideDiscount: Prisma.Decimal | null;
    discountType: DiscountType;
    overrideReason: string;
  } | null;
  /** Proration is explicit and traceable, never implicit. */
  proration?: { type: string; days: number; totalDays: number } | null;
}

export interface AmountResolution {
  /** Assignment amount, preserved on the record for audit. */
  assignmentAmount: Prisma.Decimal;
  /** Amount after proration but before discount. */
  subtotal: Prisma.Decimal;
  discountType: DiscountType;
  discountValue: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal;
  /** What the student is actually charged. */
  finalAmount: Prisma.Decimal;
  wasOverridden: boolean;
  overrideReason: string | null;
  prorationType: string | null;
  proratedDays: number | null;
  totalDays: number | null;
}

function computeDiscount(
  subtotal: Prisma.Decimal,
  type: DiscountType,
  value: Prisma.Decimal | null | undefined,
): Prisma.Decimal {
  if (!type || value == null) return money(0);
  if (type === 'percentage') {
    const pct = money(value);
    if (pct.lte(0)) return money(0);
    // Clamp so a bad value can never produce negative money.
    if (pct.gte(100)) return roundMoney(subtotal);
    return roundMoney(subtotal.times(pct).dividedBy(100));
  }
  // fixed
  const fixed = money(value);
  if (fixed.lte(0)) return money(0);
  return fixed.gt(subtotal) ? roundMoney(subtotal) : roundMoney(fixed);
}

/**
 * Resolve the chargeable amount. Precedence:
 *   1. StudentFeeOverride (explicit, audited) — overrideAmount null means waived
 *   2. Manual per-record override/percentage discount
 *   3. Class assignment amount
 * Proration is applied to the assignment/override base first, then discounts.
 */
export function resolveFeeAmount(input: AmountInput): AmountResolution {
  const assignmentAmount = roundMoney(input.assignmentAmount);

  let base = assignmentAmount;
  let wasOverridden = false;
  let overrideReason: string | null = null;

  if (input.override && input.override.overrideAmount === null) {
    // Explicit waiver: keep the assignment identifiable but charge nothing.
    return {
      assignmentAmount,
      subtotal: money(0),
      discountType: null,
      discountValue: null,
      discountAmount: money(0),
      finalAmount: money(0),
      wasOverridden: true,
      overrideReason: input.override.overrideReason || 'Waived',
      prorationType: null,
      proratedDays: null,
      totalDays: null,
    };
  }

  if (input.override?.overrideAmount != null) {
    base = roundMoney(input.override.overrideAmount);
    wasOverridden = true;
    overrideReason = input.override.overrideReason || 'Student override';
  } else if (input.manualOverride != null) {
    base = roundMoney(input.manualOverride);
    wasOverridden = true;
    overrideReason = overrideReason ?? 'Manual override';
  }

  let subtotal = base;
  let prorationType: string | null = null;
  let proratedDays: number | null = null;
  let totalDays: number | null = null;

  if (input.proration && input.proration.totalDays > 0) {
    const days = Math.min(Math.max(1, Math.trunc(input.proration.days)), input.proration.totalDays);
    prorationType = input.proration.type;
    proratedDays = days;
    totalDays = Math.trunc(input.proration.totalDays);
    subtotal = roundMoney(base.times(days).dividedBy(totalDays));
  }

  // Override-level discount wins over the manual one when both are present.
  const discountType: DiscountType = input.override?.discountType ?? input.manualDiscountType ?? null;
  const discountValue =
    input.override?.overrideDiscount != null ? input.override.overrideDiscount : (input.manualDiscountValue ?? null);
  const discountAmount = computeDiscount(subtotal, discountType, discountValue);
  const finalAmount = roundMoney(subtotal.minus(discountAmount));

  return {
    assignmentAmount,
    subtotal,
    discountType,
    discountValue,
    discountAmount,
    finalAmount: finalAmount.lt(0) ? money(0) : finalAmount,
    wasOverridden,
    overrideReason,
    prorationType,
    proratedDays,
    totalDays,
  };
}

/**
 * Admission-date proration: charge only the days of the billing month the student
 * was enrolled. Explicit and traceable via prorationType='admission_date'.
 */
export function prorationForAdmissionDate(admissionDate: Date, period: string): { type: string; days: number; totalDays: number } | null {
  const parsed = BILLING_PERIOD_RE.exec(period);
  if (!parsed) return null;
  const year = Number(parsed[1]);
  const month = Number(parsed[2]);
  const totalDays = new Date(year, month, 0).getDate();
  const admission = new Date(admissionDate);
  const admissionYear = admission.getFullYear();
  const admissionMonth = admission.getMonth() + 1;

  // Only prorate the month the student actually joined.
  if (admissionYear !== year || admissionMonth !== month) return null;
  const day = admission.getDate();
  return { type: 'admission_date', days: Math.max(1, totalDays - day + 1), totalDays };
}

export interface DuplicateCheck {
  isDuplicate: boolean;
  existingRecordId?: string;
  reason?: string;
}

/**
 * Duplicate rule: Student + Fee Category + Billing Period.
 * Backed by the unique index FeeRecord_studentId_categoryId_billingPeriod_key,
 * so this check is a UX affordance and the database remains the final authority.
 */
export async function checkDuplicate(db: Db, studentId: string, categoryId: string, billingPeriod: string): Promise<DuplicateCheck> {
  const existing = await db.feeRecord.findUnique({
    where: { studentId_categoryId_billingPeriod: { studentId, categoryId, billingPeriod } },
    include: { category: true },
  });
  if (!existing) return { isDuplicate: false };
  return {
    isDuplicate: true,
    existingRecordId: existing.id,
    reason: `Already has a ${existing.category.name} record for ${billingPeriod}.`,
  };
}

/** Standing override (period NULL) and period-scoped override, most specific wins. */
export async function findActiveOverride(db: Db, studentId: string, categoryId: string, billingPeriod: string) {
  const at = new Date();
  const candidates = await db.studentFeeOverride.findMany({
    where: {
      studentId,
      categoryId,
      OR: [{ billingPeriod }, { billingPeriod: null }],
    },
  });
  const active = candidates.filter((o) => {
    const from = o.validFrom ? new Date(o.validFrom) : null;
    const to = o.validTo ? new Date(o.validTo) : null;
    if (from && from.getTime() > at.getTime()) return false;
    if (to && to.getTime() < at.getTime()) return false;
    return true;
  });
  const periodScoped = active.find((o) => o.billingPeriod === billingPeriod);
  if (periodScoped) return periodScoped;
  return active.find((o) => o.billingPeriod === null) ?? null;
}

export interface CreateFeeRecordInput {
  studentId: string;
  categoryId: string;
  billingPeriod: string;
  source: 'manual' | 'bulk_generation' | 'package';
  notes?: string | null;
  /** Manual override of the assignment amount (authorised admin only). */
  amountOverride?: Prisma.Decimal | null;
  discountType?: DiscountType;
  discountValue?: Prisma.Decimal | null;
  /** Explicit proration; when omitted for bulk generation admission proration is derived. */
  proration?: { type: string; days: number; totalDays: number } | null;
  /** Set false only for flows that already validated assignment presence. */
  allowMissingAssignment?: boolean;
  /** Pre-allocated invoice number. Bulk callers pass a block to avoid one sequence write per record. */
  invoiceNo?: string | null;
}

export interface CreateFeeRecordResult {
  record: {
    id: string;
    studentId: string;
    categoryId: string;
    billingPeriod: string;
    amount: Prisma.Decimal;
    assignmentAmount: Prisma.Decimal | null;
    status: string;
    source: string;
  };
  resolution: AmountResolution;
  duplicate: DuplicateCheck;
}

/**
 * The one and only place a FeeRecord is created.
 * Manual creation and bulk generation both go through here so the duplicate rule,
 * amount resolution and ledger integration are identical.
 */
export async function createFeeRecord(db: Db, input: CreateFeeRecordInput): Promise<CreateFeeRecordResult> {
  const billingPeriod = assertBillingPeriod(input.billingPeriod);

  const [category, student] = await Promise.all([
    db.feeCategory.findUnique({ where: { id: input.categoryId } }),
    db.student.findUnique({ where: { id: input.studentId } }),
  ]);

  if (!category) throw new FeeError(404, 'Fee category not found.');
  if (!student) throw new FeeError(404, 'Student not found.');
  if (!category.isActive) throw new FeeError(400, `Fee category "${category.name}" is inactive.`);

  const duplicate = await checkDuplicate(db, input.studentId, input.categoryId, billingPeriod);
  if (duplicate.isDuplicate) {
    throw new FeeError(409, duplicate.reason ?? 'A fee record already exists for this student, category and period.');
  }

  // Resolve the student's class so the correct assignment is used.
  const classRow = await resolveStudentClass(db, student);

  let assignment = null as { id: string; amount: Prisma.Decimal } | null;
  if (classRow) {
    assignment = await db.feeAssignment.findFirst({
      where: { categoryId: input.categoryId, classId: classRow.id, isActive: true },
    });
  }

  // A class assignment is the default source of the amount. It is only optional when the
  // caller supplies an explicit amount (e.g. a one-time Fine added by hand).
  if (!assignment && !input.allowMissingAssignment && input.amountOverride == null) {
    const classLabel = classRow ? `${classRow.name}${classRow.section ? ` - ${classRow.section}` : ''}` : 'their class';
    throw new FeeError(
      400,
      `No fee assignment for "${category.name}" in ${classLabel}. Assign an amount on the Fee Assignments page first.`,
    );
  }

  const override = await findActiveOverride(db, input.studentId, input.categoryId, billingPeriod);
  const proration = input.proration ?? prorationForAdmissionDate(student.admissionDate, billingPeriod);

  const resolution = resolveFeeAmount({
    // With no assignment the explicit amount becomes the base; the stored
    // assignmentAmount stays NULL so the audit trail shows there was no rule.
    assignmentAmount: assignment?.amount ?? money(input.amountOverride ?? 0),
    manualOverride: input.amountOverride ?? null,
    manualDiscountType: input.discountType ?? null,
    manualDiscountValue: input.discountValue ?? null,
    override: override
      ? {
          overrideAmount: override.overrideAmount,
          overrideDiscount: override.overrideDiscount,
          discountType: (override.discountType as DiscountType) ?? null,
          overrideReason: override.overrideReason,
        }
      : null,
    proration,
  });

  const record = await db.feeRecord.create({
    data: {
      studentId: input.studentId,
      categoryId: input.categoryId,
      billingPeriod,
      assignmentId: assignment?.id ?? null,
      overrideId: override?.id ?? null,
      assignmentAmount: assignment?.amount ?? null,
      amount: resolution.finalAmount,
      discountType: resolution.discountType,
      discountValue: resolution.discountValue,
      discountAmount: resolution.discountAmount,
      prorationType: resolution.prorationType,
      proratedDays: resolution.proratedDays,
      totalDays: resolution.totalDays,
      notes: input.notes ?? null,
      source: input.source,
      status: resolution.finalAmount.lte(0) ? 'waived' : 'due',
    },
    include: { category: true },
  });

  await ensureInvoiceForRecord(db, {
    feeRecordId: record.id,
    studentId: record.studentId,
    amount: record.amount,
    billingPeriod,
    categoryName: category.name,
    invoiceNo: input.invoiceNo ?? null,
  });

  return {
    record: {
      id: record.id,
      studentId: record.studentId,
      categoryId: record.categoryId,
      billingPeriod: record.billingPeriod,
      amount: record.amount,
      assignmentAmount: record.assignmentAmount,
      status: record.status,
      source: record.source,
    },
    resolution,
    duplicate,
  };
}

/**
 * Give a FeeRecord its collectable Invoice (1:1).
 *
 * Payment.invoiceId is required, so a FeeRecord with no Invoice can never take money
 * and never shows up on the Student Fees page, which is built entirely from invoices.
 * Creating this here — rather than in each caller — means manual creation and bulk
 * generation are both collectable through the existing payment, receipt and
 * void/refund flow with no second implementation of any of it.
 *
 * Idempotent: a record can only have one bridge (enforced by a unique index), and a
 * record with no balance is waived, so it gets no Invoice and never looks collectable.
 */
export async function ensureInvoiceForRecord(
  db: Db,
  args: {
    feeRecordId: string;
    studentId: string;
    amount: Prisma.Decimal;
    billingPeriod: string;
    categoryName: string;
    /** Pre-allocated by the caller for bulk runs; otherwise one is allocated here. */
    invoiceNo?: string | null;
  },
) {
  const total = roundMoney(money(args.amount));
  // Waived/zero charges must not become an invoice: the collect list would show a
  // $0 row and the "due" total would be polluted by a fee that is not owed.
  if (total.lte(0)) return null;

  const existing = await db.invoice.findFirst({ where: { migrationFeeRecordId: args.feeRecordId } });
  if (existing) return existing;

  const year = Number(args.billingPeriod.slice(0, 4)) || new Date().getFullYear();
  const isAdmission = ADMISSION_PERIOD_RE.test(args.billingPeriod);
  const academicYear = isAdmission ? `${year}-ADM` : academicYearForMonth(year, Number(args.billingPeriod.slice(5, 7)) || 1);

  return db.invoice.create({
    data: {
      studentId: args.studentId,
      // 'fee' keeps these out of the legacy tuition generator's dedupe scope.
      type: 'fee',
      totalAmount: total,
      paidAmount: money(0),
      status: 'unpaid',
      // Monthly fees keep YYYY-MM so the existing billing-month filter works;
      // admission keeps YYYY-ADM, which the UI renders as "Admission".
      billingMonth: args.billingPeriod,
      academicYear,
      invoiceNo: args.invoiceNo ?? (await nextInvoiceNumber(db as Tx, academicYear)).invoiceNo,
      migrationFeeRecordId: args.feeRecordId,
      items: { create: [{ name: args.categoryName, amount: total }] },
    },
    include: { items: true },
  });
}

async function resolveStudentClass(db: Db, student: { id: string; class: string; section: string }) {
  // SchoolClass is keyed by (name, section); students store both as strings.
  return db.schoolClass.findFirst({
    where: { name: student.class, section: student.section },
  });
}

/** Payments are money that has already been received, so the record status is derived from them. */
export function deriveRecordStatus(
  amount: Prisma.Decimal,
  payments: Array<{ amount: any; status?: string | null }>,
): string {
  const paid = (payments ?? [])
    .filter((p) => !isVoidedPayment(p))
    .reduce((s, p) => s.plus(money(p.amount)), money(0));
  const net = roundMoney(money(amount).minus(paid));
  if (money(amount).lte(0) || net.lte(0)) return money(amount).lte(0) ? 'waived' : 'paid';
  return paid.gt(0) ? 'partial' : 'due';
}

function isVoidedPayment(p: { status?: string | null }): boolean {
  return p.status != null && String(p.status).toLowerCase() === 'voided';
}

/** Recompute a record's status from its payments. Call after any payment/void change. */
export async function refreshRecordStatus(db: Db, feeRecordId: string) {
  const record = await db.feeRecord.findUnique({
    where: { id: feeRecordId },
    include: { payments: { select: { amount: true, status: true } } },
  });
  if (!record) return null;
  const status = deriveRecordStatus(record.amount, record.payments);
  return db.feeRecord.update({ where: { id: feeRecordId }, data: { status } });
}

/**
 * Only free-text and status overrides are editable. Amount/discount changes must go
 * through a new record so historical charges are never silently rewritten.
 */
export async function updateFeeRecord(
  db: Db,
  id: string,
  updates: { notes?: string | null; status?: string },
) {
  const data: Record<string, unknown> = {};
  if (updates.notes !== undefined) data.notes = updates.notes;
  if (updates.status !== undefined) data.status = updates.status;
  if (Object.keys(data).length === 0) {
    throw new FeeError(400, 'No editable fields supplied.');
  }
  try {
    return await db.feeRecord.update({ where: { id }, data: data as any });
  } catch (error: any) {
    if (error?.code === 'P2025') throw new FeeError(404, 'Fee record not found.');
    throw error;
  }
}

/**
 * Deleting a charged record would orphan the ledger and destroy payment history,
 * so a record that has payments can only be voided by reversing its entries.
 */
export async function deleteFeeRecord(db: Db, id: string) {
  const record = await db.feeRecord.findUnique({
    where: { id },
    include: { payments: { select: { id: true, status: true } }, ledgerEntries: { select: { id: true } } },
  });
  if (!record) throw new FeeError(404, 'Fee record not found.');

  const activePayments = record.payments.filter((p) => !isVoidedPayment(p));
  if (activePayments.length > 0) {
    throw new FeeError(
      409,
      'This fee record has payments against it. Void or refund the payments before deleting the record.',
    );
  }

  // The bridged Invoice is removed with the record (FK is ON DELETE CASCADE), and
  // Invoice -> Payment is also a cascade. Voided payments are still financial history,
  // so block the delete outright rather than let them be deleted from underneath.
  const bridged = await db.invoice.findFirst({
    where: { migrationFeeRecordId: id },
    select: { id: true, payments: { select: { id: true } } },
  });
  if (bridged && bridged.payments.length > 0) {
    throw new FeeError(
      409,
      'This fee record has payment history on its invoice, so it cannot be deleted. Keep it and mark it paid or waived instead.',
    );
  }

  await db.ledgerEntry.deleteMany({ where: { feeRecordId: id } });
  return db.feeRecord.delete({ where: { id } });
}