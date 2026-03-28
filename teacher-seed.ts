import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create teachers only (skip User table for now)
  const teacher1 = await prisma.teacher.upsert({
    where: { employeeId: 'E456' },
    update: {},
    create: {
      name: 'Mr. John Doe',
      email: 'j.doe@school.com',
      employeeId: 'E456',
      phone: '+1234567890',
      subject: 'Mathematics',
    },
  });

  const teacher2 = await prisma.teacher.upsert({
    where: { employeeId: 'E457' },
    update: {},
    create: {
      name: 'Ms. Jane Smith',
      email: 'j.smith@school.com',
      employeeId: 'E457',
      phone: '+1234567891',
      subject: 'English',
    },
  });

  console.log('Created teachers:', teacher1.name, teacher2.name);

  // Create classes
  const class1 = await prisma.schoolClass.upsert({
    where: { id: 'class1' },
    update: {},
    create: {
      name: 'Grade 1',
      section: 'A',
      teacherId: teacher1.id,
    },
  });

  const class2 = await prisma.schoolClass.upsert({
    where: { id: 'class2' },
    update: {},
    create: {
      name: 'Grade 1',
      section: 'B',
      teacherId: teacher2.id,
    },
  });

  console.log('Created classes:', class1.name, class2.name);

  // Create sample students
  const student1 = await prisma.student.upsert({
    where: { admissionNo: 'A1234' },
    update: {},
    create: {
      name: 'Alice Johnson',
      admissionNo: 'A1234',
      class: 'Grade 1',
      section: 'A',
      roll: 1,
      gender: 'Female',
      dob: new Date('2018-05-15'),
      bloodGroup: 'A+',
      religion: 'Christian',
      guardianPhone: '+1234567890',
      fatherName: 'Robert Johnson',
      motherName: 'Sarah Johnson',
      phone: '+1234567890',
      email: 'alice.johnson@school.com',
    },
  });

  const student2 = await prisma.student.upsert({
    where: { admissionNo: 'A1235' },
    update: {},
    create: {
      name: 'Bob Wilson',
      admissionNo: 'A1235',
      class: 'Grade 1',
      section: 'A',
      roll: 2,
      gender: 'Male',
      dob: new Date('2018-07-22'),
      bloodGroup: 'B+',
      religion: 'Christian',
      guardianPhone: '+1234567891',
      fatherName: 'Michael Wilson',
      motherName: 'Jennifer Wilson',
      phone: '+1234567891',
      email: 'bob.wilson@school.com',
    },
  });

  console.log('Created students:', student1.name, student2.name);

  // Create subjects
  const math = await prisma.subject.upsert({
    where: { code: 'MATH' },
    update: {},
    create: {
      name: 'Mathematics',
      code: 'MATH',
      type: 'Core',
    },
  });

  const english = await prisma.subject.upsert({
    where: { code: 'ENG' },
    update: {},
    create: {
      name: 'English',
      code: 'ENG',
      type: 'Core',
    },
  });

  console.log('Created subjects:', math.name, english.name);

  console.log('Database seeded successfully!');
  console.log('\n=== LOGIN CREDENTIALS ===');
  console.log('Teacher 1:');
  console.log('  Email:', teacher1.email);
  console.log('  Password options: E456, j.doe, password, test, 123456');
  console.log('Teacher 2:');
  console.log('  Email:', teacher2.email);
  console.log('  Password options: E457, j.smith, password, test, 123456');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
