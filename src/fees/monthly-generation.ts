import { PrismaClient } from '@prisma/client';
import {
  money,
  roundMoney,
  toNumber,
  academicYearForMonth,
  billingMonthStr,
  resolveStudentTuition,
  nextInvoiceNumber,
  logAudit,
  type AssignmentLike,
  type FeeStructureLike,
} from './shared';

export interface MonthlyGenInput {
  year: number;
  month: number;
  dueDay?: number;
  classId?: string;
  prorate?: boolean;
  academicYear?: string;
}

export type MonthlyRowStatus = 'BILL' | 'SKIP_EXISTS' | 'NO_STRUCTURE';

export interface MonthlyRow {
  studentId: string;
  studentName: string;
  admissionNo: string;
  className: string;
  section: string;
  roll: number;
  base: number | null;
  discountPercent: number;
  customAmount: number | null;
  finalAmount: number | null;
  status: MonthlyRowStatus;
  reason?: string;
}

export interface MonthlySummary {
  billingMonth: string;
  academicYear: string;
  dueDay: number;
  totalStudents: number;
  toBill: number;
  alreadyBilled: number;
  notBillable: number;
  totalAmount: number;
}

export const buildMonthlyBlueprint = async (
  prisma: PrismaClient,
  input: MonthlyGenInput,
): Promise<{ rows: MonthlyRow[]; summary: MonthlySummary; classScope: { name: string; section: string } | null }> => {
  const { year, month } = input;
  const dueDay = input.dueDay ?? 10;
  const billingMonth = billingMonthStr(year, month);
  const academicYear = input.academicYear ?? academicYearForMonth(year, month);

  const structures = (await prisma.feeStructure.findMany({
    where: { isActive: true },
    include: { class: true },
  })) as FeeStructureLike[];

  let classScope: { name: string; section: string } | null = null;
  const studentWhere: any = { status: 'Active' };
  if (input.classId) {
    const cls = await prisma.schoolClass.findUnique({ where: { id: input.classId } });
    if (!cls) throw new Error('Class not found');
    classScope = { name: cls.name, section: cls.section };
    studentWhere.class = cls.name;
    studentWhere.section = cls.section;
  }

  const students = await prisma.student.findMany({
    where: studentWhere,
    orderBy: [{ class: 'asc' }, { section: 'asc' }, { roll: 'asc' }],
  });
  const ids = students.map((s) => s.id);

  const [existingInvoices, assignments] = await Promise.all([
    ids.length
      ? prisma.invoice.findMany({
          where: { type: 'tuition', billingMonth, studentId: { in: ids } },
          select: { studentId: true },
        })
      : Promise.resolve([]),
    ids.length
      ? prisma.studentFeeAssignment.findMany({
          where: { isActive: true, studentId: { in: ids } },
          include: { feeStructure: true },
        })
      : Promise.resolve([]),
  ]);

  const billedSet = new Set(existingInvoices.map((i) => i.studentId));
  const totalDaysInMonth = new Date(year, month, 0).getDate();

  const rows: MonthlyRow[] = students.map((stu) => {
    const baseRow = {
      studentId: stu.id,
      studentName: stu.name,
      admissionNo: stu.admissionNo,
      className: stu.class,
      section: stu.section,
      roll: stu.roll,
    };

    if (billedSet.has(stu.id)) {
      return {
        ...baseRow,
        base: null,
        discountPercent: 0,
        customAmount: null,
        finalAmount: null,
        status: 'SKIP_EXISTS' as const,
        reason: 'Already billed for this month',
      };
    }

    const resolution = resolveStudentTuition(stu, structures, assignments as AssignmentLike[], year, month);
    if (!resolution.finalAmount) {
      return {
        ...baseRow,
        base: null,
        discountPercent: 0,
        customAmount: null,
        finalAmount: null,
        status: 'NO_STRUCTURE' as const,
        reason: resolution.assignmentId ? 'Assignment has no usable tuition structure' : 'No active tuition structure for this class',
      };
    }

    let final = resolution.finalAmount;
    if (input.prorate) {
      const ad = stu.admissionDate;
      if (ad && ad.getFullYear() === year && ad.getMonth() + 1 === month) {
        const remainingDays = totalDaysInMonth - ad.getDate() + 1;
        final = money(final).div(totalDaysInMonth).times(remainingDays).toDecimalPlaces(2);
      }
    }

    return {
      ...baseRow,
      base: toNumber(resolution.base),
      discountPercent: resolution.discountPercent,
      customAmount: resolution.customAmount ? toNumber(resolution.customAmount) : null,
      finalAmount: toNumber(final),
      status: 'BILL' as const,
    };
  });

  const summary: MonthlySummary = {
    billingMonth,
    academicYear,
    dueDay,
    totalStudents: students.length,
    toBill: rows.filter((r) => r.status === 'BILL').length,
    alreadyBilled: rows.filter((r) => r.status === 'SKIP_EXISTS').length,
    notBillable: rows.filter((r) => r.status === 'NO_STRUCTURE').length,
    totalAmount: rows
      .filter((r) => r.status === 'BILL')
      .reduce((s, r) => s + (r.finalAmount ?? 0), 0),
  };

  return { rows, summary, classScope };
};

export const runMonthlyTuitionGeneration = async (
  prisma: PrismaClient,
  input: MonthlyGenInput,
  opts?: { actor?: string },
) => {
  const { rows, summary } = await buildMonthlyBlueprint(prisma, input);
  const dueDate = new Date(input.year, input.month - 1, summary.dueDay);

  let generated = 0;
  let skipped = summary.alreadyBilled;
  let failed = 0;
  const failedRows: Array<{ studentId: string; studentName: string; reason: string }> = [];

  for (const row of rows) {
    if (row.status !== 'BILL' || row.finalAmount == null) continue;
    const amount = roundMoney(row.finalAmount);
    try {
      await prisma.$transaction(async (tx) => {
        const { invoiceNo } = await nextInvoiceNumber(tx, summary.academicYear);
        await tx.invoice.create({
          data: {
            studentId: row.studentId,
            type: 'tuition',
            totalAmount: amount,
            status: 'unpaid',
            billingMonth: summary.billingMonth,
            academicYear: summary.academicYear,
            invoiceNo,
            dueDate,
            items: {
              create: [{ name: `Monthly Tuition - ${summary.billingMonth}`, amount }],
            },
          },
        });
        await logAudit(tx, {
          action: 'invoice.generate',
          entity: 'Invoice',
          entityId: invoiceNo,
          actor: opts?.actor,
          reason: `Monthly tuition ${summary.billingMonth}`,
          meta: { studentId: row.studentId, amount: row.finalAmount },
        });
      });
      generated++;
    } catch (e: any) {
      if (e?.code === 'P2002') {
        skipped++;
      } else {
        failed++;
        failedRows.push({ studentId: row.studentId, studentName: row.studentName, reason: e?.message ?? 'Unknown error' });
      }
    }
  }

  return {
    ...summary,
    generated,
    skipped,
    failed,
    failedRows,
    message: generated ? 'Monthly tuition generated' : 'Nothing to generate',
  };
};