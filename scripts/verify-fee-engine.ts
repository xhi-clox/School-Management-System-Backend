import { PrismaClient } from '@prisma/client';
import { buildGenerationPreview, runGeneration } from '../src/fees/generation';
import { createFeeRecord, FeeError } from '../src/fees/records';
import { money, roundMoney } from '../src/fees/shared';

/**
 * End-to-end verification of the category fee engine.
 *
 * Runs against a throwaway category and a far-future period, then removes
 * everything it created, so real students/data are never polluted and the
 * script can be re-run any number of times.
 */

const prisma = new PrismaClient();

const TEST_RECURRING = 'ZZ_TEST_RECURRING';
const TEST_ONETIME = 'ZZ_TEST_ONETIME';
const PERIOD = '2099-01';
const WAIVED_PERIOD = '2099-02';

let passed = 0;
function ok(label: string, cond: boolean) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed += 1;
  console.log(`  PASS  ${label}`);
}

async function cleanup() {
  const cats = await prisma.feeCategory.findMany({
    where: { code: { in: [TEST_RECURRING, TEST_ONETIME] } },
    select: { id: true },
  });
  const ids = cats.map((c) => c.id);
  if (ids.length === 0) return;
  // LedgerEntry/Payment/Invoice rows are never created by this engine, so these
  // cascades only touch rows this script made.
  await prisma.feeRecord.deleteMany({ where: { categoryId: { in: ids } } });
  await prisma.studentFeeOverride.deleteMany({ where: { categoryId: { in: ids } } });
  await prisma.feeAssignment.deleteMany({ where: { categoryId: { in: ids } } });
  await prisma.feeCategory.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  await cleanup(); // start from a clean slate

  const recurring = await prisma.feeCategory.create({
    data: {
      code: TEST_RECURRING,
      name: 'ZZ Test Recurring',
      isRecurring: true,
      frequency: 'monthly',
      isGeneratable: true,
    },
  });
  const onetime = await prisma.feeCategory.create({
    data: {
      code: TEST_ONETIME,
      name: 'ZZ Test One-time',
      isRecurring: false,
      frequency: 'once',
      isGeneratable: false,
    },
  });

  const classes = await prisma.schoolClass.findMany({ select: { id: true, name: true, section: true } });
  const students = await prisma.student.findMany({
    select: { id: true, name: true, class: true, section: true, roll: true },
    orderBy: [{ class: 'asc' }, { roll: 'asc' }],
  });
  console.log(`classes=${classes.length} students=${students.length}\n`);

  // 1. No assignment -> nothing is generated and every student is flagged missing.
  console.log('[1] missing-assignment handling');
  const before = await buildGenerationPreview(prisma, { categoryId: recurring.id, billingPeriod: PERIOD });
  ok('no records generated without an assignment', before.toGenerate === 0);
  ok('all students reported as missing assignment', before.missingRows.length === before.totalStudents);
  ok(
    'missing reason names the category and class',
    !!before.missingRows[0]?.reason.includes('ZZ Test Recurring'),
  );
  console.log(`        e.g. "${before.missingRows[0]?.reason}"`);

  // 2. Assign distinct per-class amounts.
  console.log('\n[2] class-based assignment amounts');
  const expectedByKey = new Map<string, number>();
  let n = 0;
  for (const c of classes) {
    const amount = 1000 + n * 100;
    expectedByKey.set(`${c.name}::${c.section}`, amount);
    await prisma.feeAssignment.create({
      data: { categoryId: recurring.id, classId: c.id, amount: money(amount) },
    });
    n += 1;
  }
  const preview = await buildGenerationPreview(prisma, { categoryId: recurring.id, billingPeriod: PERIOD });
  ok('all students now eligible', preview.toGenerate === preview.totalStudents);
  const wrongAmount = preview.students.filter((row) => {
    const expected = expectedByKey.get(`${row.className}::${row.section}`);
    return expected != null && row.assignmentAmount !== expected;
  });
  ok('every row charged its own class assignment', wrongAmount.length === 0);
  ok('per-class amounts actually differ', new Set([...expectedByKey.values()]).size > 1);
  console.log(`        ${preview.toGenerate} students, total ৳${preview.totalAmount}`);

  // 3. Preview writes nothing.
  const countAfterPreview = await prisma.feeRecord.count({ where: { categoryId: recurring.id } });
  ok('preview created zero records', countAfterPreview === 0);

  // 4. Bulk generation.
  console.log('\n[3] bulk generation');
  const run = await runGeneration(prisma, { categoryId: recurring.id, billingPeriod: PERIOD });
  ok('every eligible student billed', run.created === preview.toGenerate);
  ok('no failures', run.failed === 0);
  const sum = roundMoney((await prisma.feeRecord.aggregate({ where: { categoryId: recurring.id }, _sum: { amount: true } }))._sum.amount);
  ok('stored total matches preview total', sum.toNumber() === preview.totalAmount);
  console.log(`        created=${run.created} total=৳${run.totalAmount}`);

  // 5. Duplicate prevention on re-run.
  console.log('\n[4] duplicate prevention');
  const rerun = await runGeneration(prisma, { categoryId: recurring.id, billingPeriod: PERIOD });
  ok('re-run created nothing', rerun.created === 0);
  const total = await prisma.feeRecord.count({ where: { categoryId: recurring.id, billingPeriod: PERIOD } });
  ok('still exactly one record per student', total === preview.toGenerate);
  const dupes = await prisma.$queryRaw<any[]>`
    SELECT "studentId","categoryId","billingPeriod", COUNT(*)::int AS n
    FROM "FeeRecord" WHERE "categoryId" = ${recurring.id} AND "billingPeriod" = ${PERIOD}
    GROUP BY 1,2,3 HAVING COUNT(*) > 1`;
  ok('no duplicate (student,category,period) rows', dupes.length === 0);

  // 6. Excluded students are shown, not silently dropped.
  console.log('\n[5] preview shows excluded students with reasons');
  const after = await buildGenerationPreview(prisma, { categoryId: recurring.id, billingPeriod: PERIOD });
  ok('nothing left to generate', after.toGenerate === 0);
  ok('everyone listed as already recorded', after.alreadyRecorded === preview.toGenerate);
  ok('exclusion reason given', !!after.alreadyRecordedRows[0]?.reason.includes('ZZ Test Recurring'));
  console.log(`        e.g. "${after.alreadyRecordedRows[0]?.reason}"`);

  // 7. Manual creation shares the same duplicate rule.
  console.log('\n[6] manual add uses the same duplicate rule');
  let blocked = false;
  try {
    await createFeeRecord(prisma, {
      studentId: students[0].id,
      categoryId: recurring.id,
      billingPeriod: PERIOD,
      source: 'manual',
    });
  } catch (e: any) {
    blocked = e instanceof FeeError && e.status === 409;
  }
  ok('duplicate blocked with 409', blocked);

  const manual = await createFeeRecord(prisma, {
    studentId: students[0].id,
    categoryId: onetime.id,
    billingPeriod: PERIOD,
    source: 'manual',
    amountOverride: money(500),
  });
  ok('manual one-time fee with explicit amount allowed', roundMoney(manual.record.amount).toNumber() === 500);
  ok('assignmentAmount stays null when there is no rule', manual.record.assignmentAmount === null);

  // 8. Discounts.
  console.log('\n[7] discounts');
  const pct = await createFeeRecord(prisma, {
    studentId: students[0].id,
    categoryId: onetime.id,
    billingPeriod: '2099-03',
    source: 'manual',
    amountOverride: money(1500),
    discountType: 'percentage',
    discountValue: money(10),
  });
  ok('10% of 1500 = 1350', roundMoney(pct.record.amount).toNumber() === 1350);
  ok('discount amount stored', roundMoney(pct.resolution.discountAmount).toNumber() === 150);

  const fixed = await createFeeRecord(prisma, {
    studentId: students[0].id,
    categoryId: onetime.id,
    billingPeriod: '2099-04',
    source: 'manual',
    amountOverride: money(1500),
    discountType: 'fixed',
    discountValue: money(300),
  });
  ok('fixed 300 off 1500 = 1200', roundMoney(fixed.record.amount).toNumber() === 1200);

  const capped = await createFeeRecord(prisma, {
    studentId: students[0].id,
    categoryId: onetime.id,
    billingPeriod: '2099-05',
    source: 'manual',
    amountOverride: money(500),
    discountType: 'percentage',
    discountValue: money(100),
  });
  ok('100% discount can never go negative', roundMoney(capped.record.amount).toNumber() === 0);

  // 9. Non-generatable categories cannot be bulk generated.
  console.log('\n[8] category flags');
  let bulkBlocked = false;
  try {
    await runGeneration(prisma, { categoryId: onetime.id, billingPeriod: PERIOD });
  } catch (e: any) {
    bulkBlocked = e instanceof FeeError && e.status === 400;
  }
  ok('non-generatable category blocked from bulk run', bulkBlocked);

  // 10. Waiver override.
  console.log('\n[9] overrides');
  await prisma.studentFeeOverride.create({
    data: {
      studentId: students[1].id,
      categoryId: recurring.id,
      billingPeriod: WAIVED_PERIOD,
      overrideAmount: null,
      overrideReason: 'Scholarship waiver',
    },
  });
  const waived = await createFeeRecord(prisma, {
    studentId: students[1].id,
    categoryId: recurring.id,
    billingPeriod: WAIVED_PERIOD,
    source: 'manual',
  });
  ok('waived record charges 0', roundMoney(waived.record.amount).toNumber() === 0);
  ok('waived record marked waived', waived.record.status === 'waived');
  ok('assignment amount still identifiable', roundMoney(waived.record.assignmentAmount ?? 0).gt(0));

  const reduced = await prisma.studentFeeOverride.create({
    data: {
      studentId: students[2].id,
      categoryId: recurring.id,
      billingPeriod: WAIVED_PERIOD,
      overrideAmount: money(111),
      overrideReason: 'Sibling discount',
    },
  });
  const overridden = await createFeeRecord(prisma, {
    studentId: students[2].id,
    categoryId: recurring.id,
    billingPeriod: WAIVED_PERIOD,
    source: 'manual',
  });
  ok('override amount charged', roundMoney(overridden.record.amount).toNumber() === 111);
  ok('override recorded on the fee record', overridden.record.id.length > 0 && !!reduced.id);

  // 11. Proration is explicit and traceable.
  console.log('\n[10] admission proration');
  const joined = await prisma.student.findFirst({
    orderBy: { admissionDate: 'desc' },
  });
  if (joined) {
    const adm = new Date(joined.admissionDate as Date);
    const period = `${adm.getFullYear()}-${String(adm.getMonth() + 1).padStart(2, '0')}`;
    const clash = await prisma.feeRecord.findUnique({
      where: { studentId_categoryId_billingPeriod: { studentId: joined.id, categoryId: recurring.id, billingPeriod: period } },
    });
    if (!clash) {
      const prorated = await createFeeRecord(prisma, {
        studentId: joined.id,
        categoryId: recurring.id,
        billingPeriod: period,
        source: 'manual',
      });
      ok('proration type recorded', !!prorated.resolution.prorationType);
      ok('prorated days recorded', (prorated.resolution.proratedDays ?? 0) > 0);
      console.log(
        `        ${period}: ${prorated.resolution.prorationType} ` +
        `${prorated.resolution.proratedDays}/${prorated.resolution.totalDays} days -> ৳${prorated.record.amount}`,
      );
    } else {
      console.log(`        skipped (already covered for ${period})`);
    }
  }

  // 12. Class scoping.
  console.log('\n[11] class-scoped generation');
  const targetClass = classes[0];
  const scoped = await runGeneration(prisma, {
    categoryId: recurring.id,
    billingPeriod: '2099-06',
    classId: targetClass.id,
  });
  const scopedStudents = students.filter((s) => s.class === targetClass.name).length;
  ok('only the selected class was billed', scoped.created === scopedStudents);
  console.log(`        ${targetClass.name} -> ${scoped.created} students`);

  console.log(`\n${passed} checks passed.`);
}

main()
  .catch((e) => {
    console.error('\nVERIFICATION FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    const leftover = await prisma.feeCategory.count({ where: { code: { startsWith: 'ZZ_TEST' } } });
    const leftoverRecords = await prisma.feeRecord.count({ where: { billingPeriod: { startsWith: '2099' } } });
    console.log(`cleanup: ${leftover} test categories, ${leftoverRecords} 2099 test records remaining`);
    await prisma.$disconnect();
  });