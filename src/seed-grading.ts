import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // 1. Get an ExamType
  let examType = await prisma.examType.findFirst();
  if (!examType) {
    examType = await prisma.examType.create({
      data: { name: 'Semester' }
    });
  }

  const gradingRules = [
    { grade: 'A+', minPercent: 80, maxPercent: 100, gp: 5.0, status: 'PASS' },
    { grade: 'A', minPercent: 70, maxPercent: 79, gp: 4.0, status: 'PASS' },
    { grade: 'A-', minPercent: 60, maxPercent: 69, gp: 3.5, status: 'PASS' },
    { grade: 'B', minPercent: 50, maxPercent: 59, gp: 3.0, status: 'PASS' },
    { grade: 'C', minPercent: 40, maxPercent: 49, gp: 2.0, status: 'PASS' },
    { grade: 'D', minPercent: 33, maxPercent: 39, gp: 1.0, status: 'PASS' },
    { grade: 'F', minPercent: 0, maxPercent: 32, gp: 0.0, status: 'FAIL' },
  ];

  console.log('Seeding grading system for ExamType:', examType.name);

  for (const rule of gradingRules) {
    await prisma.gradingSystem.create({
      data: {
        ...rule,
        examTypeId: examType.id,
        status: rule.status as 'PASS' | 'FAIL'
      }
    });
  }

  console.log('Grading system seeded successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
