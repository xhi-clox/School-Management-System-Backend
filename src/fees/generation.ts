import {
  academicYearForMonth,
  money,
  nextInvoiceNumberBlock,
  roundMoney,
  type Tx,
} from './shared';
import {
  Db,
  FeeError,
  ADMISSION_PERIOD_RE,
  createFeeRecord,
  checkDuplicate,
  findActiveOverride,
  resolveFeeAmount,
  prorationForAdmissionDate,
} from './records';

/**
 * Bulk generation for any generatable fee category.
 *
 * The preview is the same computation the create step performs, so the numbers the
 * admin confirms are exactly what gets written. Creation goes through createFeeRecord,
 * which is the same function used by manual "Add Fee Record".
 */

export interface GenerationRequest {
  categoryId: string;
  billingPeriod: string;
  classId?: string | null;
}

export interface PreviewRow {
  studentId: string;
  studentName: string;
  admissionNo: string | null;
  className: string | null;
  section: string | null;
  roll: number | null;
  assignmentAmount: number;
  discountAmount: number;
  amount: number;
  overrideReason: string | null;
  prorated: boolean;
}

export interface MissingRow {
  studentId: string;
  studentName: string;
  admissionNo: string | null;
  className: string | null;
  section: string | null;
  reason: string;
}

/** A student not billed because they are not Active. */
export interface InactiveRow {
  studentId: string;
  studentName: string;
  admissionNo: string | null;
  className: string | null;
  section: string | null;
  status: string;
  reason: string;
}

export interface AlreadyRecordedRow {
  studentId: string;
  studentName: string;
  admissionNo: string | null;
  className: string | null;
  section: string | null;
  recordId: string;
  amount: number;
  reason: string;
}

export interface GenerationPreview {
  categoryId: string;
  categoryName: string;
  billingPeriod: string;
  totalStudents: number;
  toGenerate: number;
  alreadyRecorded: number;
  missingAssignments: number;
  /** Students excluded because they are not Active. */
  inactive: number;
  totalAmount: number;
  students: PreviewRow[];
  alreadyRecordedRows: AlreadyRecordedRow[];
  missingRows: MissingRow[];
  inactiveRows: InactiveRow[];
}

async function loadEligibleStudents(db: Db) {
  return db.student.findMany({
    orderBy: [{ class: 'asc' }, { roll: 'asc' }],
    select: {
      id: true,
      name: true,
      admissionNo: true,
      class: true,
      section: true,
      roll: true,
      admissionDate: true,
      status: true,
    },
  });
}

/**
 * classId in the request may be a SchoolClass id or a plain class name. The UI works
 * in class names, so match whichever the caller supplied.
 */
async function filterByClass<T extends { class: string }>(db: Db, students: T[], classId?: string | null): Promise<T[]> {
  if (!classId) return students;
  const classRow = await db.schoolClass.findFirst({ where: { id: classId } });
  const wanted = classRow ? classRow.name : classId;
  return students.filter((s) => s.class === wanted);
}

export async function buildGenerationPreview(db: Db, request: GenerationRequest): Promise<GenerationPreview> {
  const category = await db.feeCategory.findUnique({ where: { id: request.categoryId } });
  if (!category) throw new FeeError(404, 'Fee category not found.');

  const allStudents = await loadEligibleStudents(db);
  const scoped = await filterByClass(db, allStudents, request.classId);

  // Withdrawn, inactive and graduated students must not be billed. They are reported
  // separately rather than dropped silently, so the totals can be reconciled.
  const students = scoped.filter((s) => s.status === 'Active');
  const inactiveRows: InactiveRow[] = scoped
    .filter((s) => s.status !== 'Active')
    .map((s) => ({
      studentId: s.id,
      studentName: s.name,
      admissionNo: s.admissionNo,
      className: s.class,
      section: s.section,
      status: s.status ?? 'unknown',
      reason: `Student is ${s.status ?? 'not active'}.`,
    }));

  const classNames = [...new Set(students.map((s) => s.class))];
  const classRows = await db.schoolClass.findMany({ where: { name: { in: classNames } } });

  // className + section -> SchoolClass.id
  const classIdByKey = new Map<string, string>();
  for (const row of classRows) {
    classIdByKey.set(`${row.name}::${row.section}`, row.id);
    if (!classRows.some((r) => r.name === row.name && r.section !== row.section)) {
      // Fallback for students whose section no longer matches a class row.
      classIdByKey.set(`${row.name}::*`, row.id);
    }
  }

  const assignments = await db.feeAssignment.findMany({
    where: { categoryId: category.id, isActive: true },
  });
  const assignmentByClassId = new Map(assignments.map((a) => [a.classId, a]));

  // One query for existing records so previews stay fast on large schools.
  const existingRecords = await db.feeRecord.findMany({
    where: {
      categoryId: category.id,
      billingPeriod: request.billingPeriod,
      studentId: { in: students.map((s) => s.id) },
    },
    select: { id: true, studentId: true, amount: true },
  });
  const existingByStudent = new Map(existingRecords.map((r) => [r.studentId, r]));

  const overrides = await db.studentFeeOverride.findMany({
    where: {
      categoryId: category.id,
      OR: [{ billingPeriod: request.billingPeriod }, { billingPeriod: null }],
      studentId: { in: students.map((s) => s.id) },
    },
  });
  const now = new Date();
  const activeOverrides = new Map<string, (typeof overrides)[number]>();
  for (const o of overrides) {
    const from = o.validFrom ? new Date(o.validFrom) : null;
    const to = o.validTo ? new Date(o.validTo) : null;
    if (from && from.getTime() > now.getTime()) continue;
    if (to && to.getTime() < now.getTime()) continue;
    const key = `${o.studentId}::${o.billingPeriod ?? '*'}`;
    if (o.billingPeriod === request.billingPeriod) activeOverrides.set(key, o);
  }
  for (const o of overrides) {
    const key = `${o.studentId}::*`;
    if (!activeOverrides.has(key) && o.billingPeriod === null) {
      const from = o.validFrom ? new Date(o.validFrom) : null;
      const to = o.validTo ? new Date(o.validTo) : null;
      if (from && from.getTime() > now.getTime()) continue;
      if (to && to.getTime() < now.getTime()) continue;
      activeOverrides.set(key, o);
    }
  }

  const students_: PreviewRow[] = [];
  const missingRows: MissingRow[] = [];
  const alreadyRecordedRows: AlreadyRecordedRow[] = [];

  for (const student of students) {
    const base = {
      studentId: student.id,
      studentName: student.name,
      admissionNo: student.admissionNo,
      className: student.class,
      section: student.section,
    };

    const existing = existingByStudent.get(student.id);
    if (existing) {
      alreadyRecordedRows.push({
        ...base,
        recordId: existing.id,
        amount: roundMoney(existing.amount).toNumber(),
        reason: `Already has a ${category.name} record for ${request.billingPeriod}.`,
      });
      continue;
    }

    const classId = classIdByKey.get(`${student.class}::${student.section}`) ?? classIdByKey.get(`${student.class}::*`);
    const assignment = classId ? assignmentByClassId.get(classId) : undefined;

    if (!assignment) {
      missingRows.push({
        ...base,
        reason: classId
          ? `No ${category.name} amount assigned for ${student.class}${student.section ? ` - ${student.section}` : ''}.`
          : `Class "${student.class}" is not configured, so no ${category.name} amount could be found.`,
      });
      continue;
    }

    const override = activeOverrides.get(`${student.id}::${request.billingPeriod}`) ?? activeOverrides.get(`${student.id}::*`) ?? null;
    const proration = prorationForAdmissionDate(student.admissionDate, request.billingPeriod);
    const resolution = resolveFeeAmount({
      assignmentAmount: assignment.amount,
      override: override
        ? {
            overrideAmount: override.overrideAmount,
            overrideDiscount: override.overrideDiscount,
            discountType: (override.discountType as 'percentage' | 'fixed' | null) ?? null,
            overrideReason: override.overrideReason,
          }
        : null,
      proration,
    });

    students_.push({
      ...base,
      roll: student.roll,
      assignmentAmount: resolution.assignmentAmount.toNumber(),
      discountAmount: resolution.discountAmount.toNumber(),
      amount: resolution.finalAmount.toNumber(),
      overrideReason: resolution.overrideReason,
      prorated: !!resolution.prorationType,
    });
  }

  const totalAmount = students_.reduce((sum, row) => sum.plus(money(row.amount)), money(0));

  return {
    categoryId: category.id,
    categoryName: category.name,
    billingPeriod: request.billingPeriod,
    totalStudents: students.length,
    toGenerate: students_.length,
    alreadyRecorded: alreadyRecordedRows.length,
    missingAssignments: missingRows.length,
    inactive: inactiveRows.length,
    totalAmount: roundMoney(totalAmount).toNumber(),
    students: students_,
    alreadyRecordedRows,
    missingRows,
    inactiveRows,
  };
}

export interface GenerationResult {
  billingPeriod: string;
  categoryId: string;
  categoryName: string;
  created: number;
  skipped: number;
  waived: number;
  missing: number;
  /** Students skipped because they are not Active. */
  inactive: number;
  failed: number;
  totalAmount: number;
  createdRecords: Array<{ id: string; studentId: string; amount: number }>;
  failedRows: Array<{ studentId: string; studentName: string; reason: string }>;
}

/**
 * Runs the preview again (so amounts are fresh), then writes through createFeeRecord.
 * Rows that became duplicates between preview and confirm are reported as skipped
 * instead of aborting the whole run.
 */
export async function runGeneration(db: Db, request: GenerationRequest): Promise<GenerationResult> {
  const category = await db.feeCategory.findUnique({ where: { id: request.categoryId } });
  if (!category) throw new FeeError(404, 'Fee category not found.');
  if (!category.isGeneratable) {
    throw new FeeError(400, `"${category.name}" is not generatable in bulk. Add it as an individual fee record instead.`);
  }

  const preview = await buildGenerationPreview(db, request);

  const createdRecords: GenerationResult['createdRecords'] = [];
  const failedRows: GenerationResult['failedRows'] = [];
  let skipped = 0;
  let waived = 0;
  let totalAmount = money(0);

  // Every invoice created below would otherwise do its own sequence write, which is
  // hundreds of extra round trips on a run the size of the whole school. One
  // increment hands out the whole block up front; the index is only advanced for
  // rows we actually charge, and a shortfall falls back to per-row allocation.
  const year = Number(request.billingPeriod.slice(0, 4)) || new Date().getFullYear();
  const academicYear = ADMISSION_PERIOD_RE.test(request.billingPeriod)
    ? `${year}-ADM`
    : academicYearForMonth(year, Number(request.billingPeriod.slice(5, 7)) || 1);
  let block = await nextInvoiceNumberBlock(db as Tx, academicYear, preview.students.length);
  let blockIndex = 0;

  for (const row of preview.students) {
    try {
      const invoiceNo = blockIndex < block.invoiceNos.length ? block.invoiceNos[blockIndex] : null;
      const outcome = await createFeeRecord(db, {
        studentId: row.studentId,
        categoryId: category.id,
        billingPeriod: request.billingPeriod,
        source: 'bulk_generation',
        invoiceNo,
      });
      blockIndex += 1;
      createdRecords.push({ id: outcome.record.id, studentId: row.studentId, amount: row.amount });
      totalAmount = totalAmount.plus(outcome.record.amount);
      if (outcome.record.status === 'waived') waived += 1;
    } catch (error: any) {
      if (error?.status === 409) {
        skipped += 1;
        continue;
      }
      failedRows.push({
        studentId: row.studentId,
        studentName: row.studentName,
        reason: error?.message ?? 'Unknown error',
      });
    }
  }

  return {
    billingPeriod: request.billingPeriod,
    categoryId: category.id,
    categoryName: category.name,
    created: createdRecords.length,
    skipped,
    waived,
    missing: preview.missingRows.length,
    inactive: preview.inactiveRows.length,
    failed: failedRows.length,
    totalAmount: roundMoney(totalAmount).toNumber(),
    createdRecords,
    failedRows,
  };
}

export { checkDuplicate, findActiveOverride };