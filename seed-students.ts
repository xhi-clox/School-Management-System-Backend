import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding students with emails...');

  // Create students with email addresses
  const student1 = await prisma.student.upsert({
    where: { admissionNo: 'A1234' },
    update: {
      email: 'alice.johnson@school.com'
    },
    create: {
      name: 'Alice Johnson',
      admissionNo: 'A1234',
      email: 'alice.johnson@school.com',
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
      phone: '+1234567890'
    },
  });

  const student2 = await prisma.student.upsert({
    where: { admissionNo: 'A1235' },
    update: {
      email: 'bob.wilson@school.com'
    },
    create: {
      name: 'Bob Wilson',
      admissionNo: 'A1235',
      email: 'bob.wilson@school.com',
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
      phone: '+1234567891'
    },
  });

  console.log('Students created with emails:');
  console.log('-', student1.name, ':', student1.email);
  console.log('-', student2.name, ':', student2.email);
  console.log('\n✅ Student login credentials:');
  console.log('Email: alice.johnson@school.com or bob.wilson@school.com');
  console.log('Password: Any password (students accept any password)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
