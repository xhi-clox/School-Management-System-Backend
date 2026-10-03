import { PrismaClient } from '@prisma/client';

/**
 * Repairs `Student.admissionStatus` for students that predate the category fee
 * system.
 *
 * The additive migration added `admissionStatus` with a default of 'pending',
 * which silently labelled every already-enrolled student as still awaiting
 * admission. This derives the accurate value instead of trusting the default:
 *
 *   - student has an ADMISSION FeeRecord -> mirror that record's status
 *   - no FeeRecord + student is Active   -> 'completed' (already enrolled)
 *   - no FeeRecord + student not Active  -> 'pending' (still owes admission)
 *
 * Safe to re-run: it only ever writes the value it believes is correct.
 */

const prisma = new PrismaClient();

async function main() {
  const admission = await prisma.feeCategory.findUnique({ where: { code: 'ADMISSION' } });

  const students = await prisma.student.findMany({
    select: {
      id: true,
      name: true,
      status: true,
      admissionStatus: true,
      admissionFeeRecordId: true,
    },
  });

  const recordStatus = new Map<string, string>();
  if (admission) {
    const records = await prisma.feeRecord.findMany({
      where: { categoryId: admission.id },
      select: { id: true, studentId: true, status: true },
    });
    for (const r of records) recordStatus.set(r.studentId, r.status);
  }

  const updates: { id: string; admissionStatus: string }[] = [];
  const skipped: string[] = [];

  for (const s of students) {
    let next: string;
    if (recordStatus.has(s.id)) {
      next = recordStatus.get(s.id) as string;
    } else if (s.status === 'Active') {
      next = 'completed';
    } else {
      next = 'pending';
    }

    if (s.admissionStatus !== next) {
      updates.push({ id: s.id, admissionStatus: next });
    }
  }

  if (updates.length === 0) {
    console.log('Nothing to repair - admissionStatus already consistent.');
  } else {
    for (const u of updates) {
      await prisma.student.update({ where: { id: u.id }, data: { admissionStatus: u.admissionStatus } });
    }
    const completed = updates.filter((u) => u.admissionStatus === 'completed').length;
    const pending = updates.length - completed;
    console.log(`Updated ${updates.length} students: ${completed} -> completed, ${pending} -> pending`);
  }

  const after = await prisma.student.groupBy({
    by: ['status', 'admissionStatus'],
    _count: { _all: true },
  });
  console.log('\nDistribution after repair:');
  for (const r of after) {
    console.log(
      `  status=${(r.status ?? 'null').padEnd(16)} admissionStatus=${(r.admissionStatus ?? 'null').padEnd(16)} count=${r._count._all}`,
    );
  }
  console.log(`\nSkipped (no change needed): ${skipped.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());