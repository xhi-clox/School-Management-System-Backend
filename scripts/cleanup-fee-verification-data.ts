import { PrismaClient } from '@prisma/client';

/**
 * Removes records created by earlier ad-hoc verification runs (2026-10 .. 2026-12)
 * plus the fabricated class tuition amounts that were used as test data.
 * Real academic data is never touched.
 */

const prisma = new PrismaClient();

const TEST_PERIODS = ['2026-10', '2026-11', '2026-12'];
const TEST_NOTES = ['verification run'];

async function main() {
  const tuition = await prisma.feeCategory.findUnique({ where: { code: 'TUITION' } });
  const fine = await prisma.feeCategory.findUnique({ where: { code: 'FINE' } });
  const testIds = [tuition?.id, fine?.id].filter(Boolean) as string[];

  const byPeriod = await prisma.feeRecord.deleteMany({
    where: { billingPeriod: { in: TEST_PERIODS }, ...(testIds.length ? { categoryId: { in: testIds } } : {}) },
  });
  const byNote = await prisma.feeRecord.deleteMany({ where: { notes: { in: TEST_NOTES } } });
  const overrides = await prisma.studentFeeOverride.deleteMany({
    where: { categoryId: { in: testIds }, overrideReason: { contains: 'verification' } },
  });
  const assignments = await prisma.feeAssignment.deleteMany({
    where: { categoryId: { in: testIds } },
  });

  console.log(`fee records removed: ${byPeriod.count} (by period) + ${byNote.count} (by note)`);
  console.log(`overrides removed: ${overrides.count}`);
  console.log(`test class assignments removed: ${assignments.count}`);

  const remainingRecords = await prisma.feeRecord.count();
  const remainingAssignments = await prisma.feeAssignment.count();
  const categories = await prisma.feeCategory.count();
  console.log(`\nNow: ${categories} categories, ${remainingAssignments} assignments, ${remainingRecords} fee records`);

  const counts = {
    students: await prisma.student.count(),
    results: await prisma.result.count(),
    exams: await prisma.exam.count(),
    subjects: await prisma.subject.count(),
    classes: await prisma.schoolClass.count(),
  };
  console.log('Academic data untouched:', JSON.stringify(counts));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());