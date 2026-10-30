import { PrismaClient } from '@prisma/client';

/**
 * Seed script for the new Fee System
 * 
 * Initializes:
 * 1. Base FeeCategory records (ADMISSION, TUITION, TRANSPORT, EXAM, etc.)
 * 2. FeeAssignment records for each class/category combination
 * 3. Sample StudentFeeOverride records (optional scholarships)
 * 
 * Run with: npx ts-node seed-fee-system.ts
 */

const prisma = new PrismaClient();

interface CategoryConfig {
  code: string;
  name: string;
  description?: string;
  isRecurring: boolean;
  frequency: 'monthly' | 'annual' | 'term' | 'once';
  isGeneratable: boolean;
  amount?: { [classId: string]: number }; // Optional: default amounts per class
}

const DEFAULT_CATEGORIES: CategoryConfig[] = [
  {
    code: 'ADMISSION',
    name: 'Admission Fee',
    description: 'One-time fee charged at admission',
    isRecurring: false,
    frequency: 'once',
    isGeneratable: false,
  },
  {
    code: 'TUITION',
    name: 'Monthly Tuition',
    description: 'Regular monthly tuition fee',
    isRecurring: true,
    frequency: 'monthly',
    isGeneratable: true,
  },
  {
    code: 'TRANSPORT',
    name: 'Transport Fee',
    description: 'Monthly transport/bus fee',
    isRecurring: true,
    frequency: 'monthly',
    isGeneratable: true,
  },
  {
    code: 'EXAM',
    name: 'Exam Fee',
    description: 'Exam administration fee',
    isRecurring: true,
    frequency: 'term',
    isGeneratable: true,
  },
  {
    code: 'LIBRARY',
    name: 'Library Fee',
    description: 'Library maintenance and subscription',
    isRecurring: true,
    frequency: 'annual',
    isGeneratable: true,
  },
  {
    code: 'FINE',
    name: 'Late Fee / Fine',
    description: 'Late payment fee or other fines',
    isRecurring: false,
    frequency: 'once',
    isGeneratable: false,
  },
];

// Default fee amounts per class (in BDT)
const DEFAULT_AMOUNTS: { [classRange: string]: { [category: string]: number } } = {
  'Nursery': {
    ADMISSION: 5000,
    TUITION: 3000,
    TRANSPORT: 1500,
    EXAM: 500,
    LIBRARY: 500,
  },
  'Play Group': {
    ADMISSION: 5000,
    TUITION: 3500,
    TRANSPORT: 1500,
    EXAM: 500,
    LIBRARY: 500,
  },
  'Class 1': {
    ADMISSION: 8000,
    TUITION: 4000,
    TRANSPORT: 2000,
    EXAM: 1000,
    LIBRARY: 500,
  },
  'Class 2': {
    ADMISSION: 8000,
    TUITION: 4000,
    TRANSPORT: 2000,
    EXAM: 1000,
    LIBRARY: 500,
  },
  'Class 3': {
    ADMISSION: 10000,
    TUITION: 5000,
    TRANSPORT: 2000,
    EXAM: 1500,
    LIBRARY: 500,
  },
  'Class 4': {
    ADMISSION: 10000,
    TUITION: 5000,
    TRANSPORT: 2000,
    EXAM: 1500,
    LIBRARY: 500,
  },
  'Class 5': {
    ADMISSION: 10000,
    TUITION: 5000,
    TRANSPORT: 2000,
    EXAM: 1500,
    LIBRARY: 500,
  },
};

async function seedFeeSystem() {
  console.log('🌱 Starting Fee System seed...\n');

  try {
    // 1. Seed FeeCategories
    console.log('📋 Creating Fee Categories...');
    const categories: { [code: string]: string } = {};

    for (const categoryConfig of DEFAULT_CATEGORIES) {
      const existing = await prisma.feeCategory.findUnique({
        where: { code: categoryConfig.code },
      });

      if (existing) {
        console.log(`  ✓ ${categoryConfig.code} already exists`);
        categories[categoryConfig.code] = existing.id;
        continue;
      }

      const category = await prisma.feeCategory.create({
        data: {
          code: categoryConfig.code,
          name: categoryConfig.name,
          description: categoryConfig.description,
          isRecurring: categoryConfig.isRecurring,
          frequency: categoryConfig.frequency,
          isGeneratable: categoryConfig.isGeneratable,
          isActive: true,
        },
      });

      console.log(`  ✓ Created ${categoryConfig.code} (${categoryConfig.name})`);
      categories[categoryConfig.code] = category.id;
    }

    // 2. Seed FeeAssignments
    console.log('\n🏫 Creating Fee Assignments per class...');

    // Get all active classes
    const classes = await prisma.schoolClass.findMany({
      select: { id: true, name: true, section: true },
    });

    if (classes.length === 0) {
      console.log('  ⚠️  No classes found. Create classes first.');
      return;
    }

    let assignmentCount = 0;

    for (const schoolClass of classes) {
      const classKey = schoolClass.name; // Use class name to match DEFAULT_AMOUNTS
      const amounts = DEFAULT_AMOUNTS[classKey];

      if (!amounts) {
        console.log(`  ⚠️  No default amounts configured for class "${classKey}"`);
        continue;
      }

      for (const [categoryCode, amount] of Object.entries(amounts)) {
        const categoryId = categories[categoryCode];
        if (!categoryId) {
          console.log(`    ⚠️  Category ${categoryCode} not found`);
          continue;
        }

        const existing = await prisma.feeAssignment.findUnique({
          where: {
            categoryId_classId: {
              categoryId,
              classId: schoolClass.id,
            },
          },
        });

        if (existing) {
          continue; // Already exists
        }

        await prisma.feeAssignment.create({
          data: {
            categoryId,
            classId: schoolClass.id,
            amount: amount,
            isActive: true,
          },
        });

        assignmentCount++;
      }
    }

    console.log(`  ✓ Created ${assignmentCount} fee assignments`);

    // 3. Report
    console.log('\n✅ Fee System seed completed successfully!');
    console.log('\n📊 Summary:');
    console.log(`  - Fee Categories: ${Object.keys(categories).length}`);
    console.log(`  - Classes: ${classes.length}`);
    console.log(`  - Fee Assignments: ${assignmentCount}`);
    console.log('\n🚀 Ready to generate fees with POST /fees/generate');
  } catch (error) {
    console.error('❌ Seed failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the seed
seedFeeSystem().catch((error) => {
  console.error(error);
  process.exit(1);
});
