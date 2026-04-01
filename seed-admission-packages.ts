import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding admission packages...');

  // Get existing classes
  const classes = await prisma.schoolClass.findMany();
  
  if (classes.length === 0) {
    console.log('No classes found. Please create classes first.');
    return;
  }

  // Create admission packages for each class
  for (const cls of classes) {
    const existingPackage = await prisma.admissionPackage.findFirst({
      where: { classId: cls.id }
    });

    if (!existingPackage) {
      await prisma.admissionPackage.create({
        data: {
          name: `${cls.name} Admission Package`,
          session: '2024-2025',
          classId: cls.id,
          description: `Standard admission package for ${cls.name}`,
          isActive: true,
          feeItems: {
            create: [
              { name: 'Admission Fee', amount: 5000 },
              { name: 'Tuition Fee (Monthly)', amount: 3000 },
              { name: 'Examination Fee', amount: 1000 },
              { name: 'Library Fee', amount: 500 },
              { name: 'Laboratory Fee', amount: 800 }
            ]
          }
        }
      });
      console.log(`Created admission package for ${cls.name}`);
    } else {
      console.log(`Admission package already exists for ${cls.name}`);
    }
  }

  console.log('✅ Admission packages seeded successfully!');
  
  // List all packages
  const packages = await prisma.admissionPackage.findMany({
    include: { feeItems: true, class: true }
  });
  
  console.log('\n📦 Available Admission Packages:');
  packages.forEach(pkg => {
    const total = pkg.feeItems.reduce((sum, item) => sum + item.amount, 0);
    console.log(`- ${pkg.name} (${pkg.class?.name}): $${total}`);
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
