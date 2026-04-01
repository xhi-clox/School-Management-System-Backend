import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding classes and admission packages...');

  // Create classes
  const classData = [
    { name: 'Play Group', section: 'A' },
    { name: 'Nursery', section: 'A' },
    { name: 'Kindergarten', section: 'A' },
    { name: 'Grade 1', section: 'A' },
    { name: 'Grade 1', section: 'B' },
    { name: 'Grade 2', section: 'A' },
    { name: 'Grade 2', section: 'B' },
    { name: 'Grade 3', section: 'A' },
    { name: 'Grade 4', section: 'A' },
    { name: 'Grade 5', section: 'A' },
    { name: 'Grade 6', section: 'A' },
    { name: 'Grade 7', section: 'A' },
    { name: 'Grade 8', section: 'A' },
    { name: 'Grade 9', section: 'A' },
    { name: 'Grade 10', section: 'A' },
  ];

  const createdClasses = [];
  for (const cls of classData) {
    const existing = await prisma.schoolClass.findFirst({
      where: { name: cls.name, section: cls.section }
    });
    
    if (!existing) {
      const newClass = await prisma.schoolClass.create({
        data: {
          name: cls.name,
          section: cls.section,
        }
      });
      createdClasses.push(newClass);
      console.log(`Created class: ${cls.name} - ${cls.section}`);
    } else {
      createdClasses.push(existing);
      console.log(`Class already exists: ${cls.name} - ${cls.section}`);
    }
  }

  // Create admission packages for each class
  for (const cls of createdClasses) {
    const existingPackage = await prisma.admissionPackage.findFirst({
      where: { classId: cls.id }
    });

    if (!existingPackage) {
      const baseAmount = cls.name.includes('Play') || cls.name.includes('Nursery') || cls.name.includes('Kindergarten') 
        ? 3000 : cls.name.includes('Grade 1') || cls.name.includes('Grade 2') || cls.name.includes('Grade 3')
        ? 4000 : cls.name.includes('Grade 4') || cls.name.includes('Grade 5') || cls.name.includes('Grade 6')
        ? 5000 : 6000;

      await prisma.admissionPackage.create({
        data: {
          name: `${cls.name} ${cls.section} Admission Package`,
          session: '2024-2025',
          classId: cls.id,
          description: `Standard admission package for ${cls.name} ${cls.section}`,
          isActive: true,
          feeItems: {
            create: [
              { name: 'Admission Fee', amount: baseAmount },
              { name: 'Tuition Fee (Monthly)', amount: Math.round(baseAmount * 0.6) },
              { name: 'Examination Fee', amount: Math.round(baseAmount * 0.2) },
              { name: 'Library Fee', amount: Math.round(baseAmount * 0.1) },
              { name: 'Laboratory Fee', amount: Math.round(baseAmount * 0.15) }
            ]
          }
        }
      });
      console.log(`Created admission package for ${cls.name} ${cls.section}`);
    } else {
      console.log(`Package exists for ${cls.name} ${cls.section}`);
    }
  }

  console.log('✅ Classes and Admission Packages seeded!');
  
  // List all packages
  const packages = await prisma.admissionPackage.findMany({
    include: { feeItems: true, class: true }
  });
  
  console.log('\n📦 Available Admission Packages:');
  packages.forEach(pkg => {
    const total = pkg.feeItems.reduce((sum, item) => sum + item.amount, 0);
    console.log(`- ${pkg.class?.name} ${pkg.class?.section}: $${total} (${pkg.id})`);
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
