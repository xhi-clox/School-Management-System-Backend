import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding teachers for login testing...');

  // Create teachers only
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

  console.log('✅ Teachers created successfully!');
  console.log('\n=== 🎯 LOGIN CREDENTIALS ===');
  console.log('\n👨‍🏫 Teacher 1:');
  console.log('  📧 Email:', teacher1.email);
  console.log('  🔑 Password options:');
  console.log('    - E456 (employee ID)');
  console.log('    - j.doe (email prefix)');
  console.log('    - password');
  console.log('    - test');
  console.log('    - 123456');
  
  console.log('\n👩‍🏫 Teacher 2:');
  console.log('  📧 Email:', teacher2.email);
  console.log('  🔑 Password options:');
  console.log('    - E457 (employee ID)');
  console.log('    - j.smith (email prefix)');
  console.log('    - password');
  console.log('    - test');
  console.log('    - 123456');

  console.log('\n🚀 Ready to test teacher login!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
