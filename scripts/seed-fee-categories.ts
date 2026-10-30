import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Idempotent starter categories. Admins can rename, edit, deactivate or add
 * unlimited custom categories from the Fee Categories page.
 */
const DEFAULTS = [
  { code: 'TUITION', name: 'Monthly Tuition', description: 'Recurring monthly class fee', isRecurring: true, frequency: 'monthly', isGeneratable: true },
  { code: 'ADMISSION', name: 'Admission Fee', description: 'One-time admission charge created with the student', isRecurring: false, frequency: 'once', isGeneratable: false },
  { code: 'TRANSPORT', name: 'Transport Fee', description: 'Optional school transport charge', isRecurring: true, frequency: 'monthly', isGeneratable: true },
  { code: 'EXAM', name: 'Exam Fee', description: 'Per-term examination charge', isRecurring: false, frequency: 'term', isGeneratable: true },
  { code: 'LIBRARY', name: 'Library Fee', description: 'Library membership charge', isRecurring: true, frequency: 'monthly', isGeneratable: true },
  { code: 'LABORATORY', name: 'Laboratory Fee', description: 'Science laboratory usage charge', isRecurring: true, frequency: 'monthly', isGeneratable: true },
  { code: 'SPORTS', name: 'Sports Fee', description: 'Sports and activities charge', isRecurring: false, frequency: 'term', isGeneratable: true },
  { code: 'FINE', name: 'Fine', description: 'Penalty or fine, added individually', isRecurring: false, frequency: 'once', isGeneratable: false },
];

async function main() {
  for (const c of DEFAULTS) {
    const existing = await prisma.feeCategory.findUnique({ where: { code: c.code } });
    if (existing) {
      console.log(`= exists  ${c.code.padEnd(12)} ${existing.name}`);
      continue;
    }
    await prisma.feeCategory.create({ data: c });
    console.log(`+ created ${c.code.padEnd(12)} ${c.name}`);
  }

  const total = await prisma.feeCategory.count();
  const generatable = await prisma.feeCategory.count({ where: { isGeneratable: true, isActive: true } });
  console.log(`\nTotal categories: ${total} (${generatable} bulk-generatable)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());