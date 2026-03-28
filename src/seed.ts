import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Seed students
  const studentsData = [
    { name: 'Alice Johnson', admissionNo: 'A1234', class: 'Grade 10', section: 'A', roll: 1, gender: 'Female', guardianPhone: '555-0101' },
    { name: 'Bob Smith', admissionNo: 'A1235', class: 'Grade 10', section: 'A', roll: 2, gender: 'Male', guardianPhone: '555-0102' },
    { name: 'Charlie Brown', admissionNo: 'A1236', class: 'Grade 10', section: 'B', roll: 1, gender: 'Male', guardianPhone: '555-0103' },
  ];
  const students = await prisma.$transaction(
    studentsData.map((s) => prisma.student.upsert({
      where: { admissionNo: s.admissionNo },
      update: {},
      create: s
    }))
  );

  // Seed teachers
  const teachersData = [
    { name: 'Mr. John Doe', employeeId: 'E456', subject: 'Mathematics', email: 'j.doe@school.com', phone: '+1234567890' },
    { name: 'Ms. Jane Smith', employeeId: 'E457', subject: 'Science', email: 'j.smith@school.com', phone: '+1234567891' },
  ];
  const teachers = await prisma.$transaction(
    teachersData.map((t) => prisma.teacher.upsert({
      where: { employeeId: t.employeeId },
      update: {},
      create: t
    }))
  );

  // Seed fees
  if (students.length) {
    await prisma.studentFee.createMany({
      data: [
        { studentId: students[0].id, feeType: 'Tuition', amount: 500, discount: 50, status: 'Paid' },
        { studentId: students[1].id, feeType: 'Tuition', amount: 500, discount: 0, status: 'Due' },
      ],
    });
  }

  // Seed expenses
  await prisma.schoolExpense.createMany({
    data: [
      { category: 'Bills', amount: 1500, date: new Date('2023-10-25'), notes: 'Electricity and Water bills' },
      { category: 'Maintenance', amount: 600, date: new Date('2023-10-20'), notes: 'Classroom repairs' },
    ],
  });

  // Seed salaries
  if (teachers.length) {
    await prisma.teacherSalary.create({
      data: {
        teacherId: teachers[0].id,
        baseSalary: 3000,
        bonus: 200,
        deductions: 100,
        netSalary: 3100,
        paymentDate: new Date('2023-10-30'),
        status: 'Paid',
      },
    });
  }

  // Seed users
  const hashedPassword = await bcrypt.hash('password', 10);
  await prisma.user.createMany({
    data: [
      { email: 'admin@academify.com', password: hashedPassword, role: 'Admin' },
      { email: 'teacher@academify.com', password: hashedPassword, role: 'Teacher' },
      { email: 'student@academify.com', password: hashedPassword, role: 'Student' },
      { email: 'parent@academify.com', password: hashedPassword, role: 'Parent' },
    ],
    skipDuplicates: true,
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log('Seed complete');
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
