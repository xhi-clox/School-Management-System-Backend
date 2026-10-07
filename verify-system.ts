import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function verifySystem() {
  console.log('🔍 Verifying Fee System Setup\n');

  try {
    // Check data counts
    const [feeCategories, feeAssignments, feeRecords, students, invoices, payments] = await Promise.all([
      prisma.feeCategory.count(),
      prisma.feeAssignment.count(),
      prisma.feeRecord.count(),
      prisma.student.count(),
      prisma.invoice.count(),
      prisma.payment.count(),
    ]);

    console.log('📊 Database Table Counts:');
    console.log(`  FeeCategory:     ${feeCategories} records`);
    console.log(`  FeeAssignment:   ${feeAssignments} records`);
    console.log(`  FeeRecord:       ${feeRecords} records`);
    console.log(`  Student:         ${students} records`);
    console.log(`  Invoice:         ${invoices} records`);
    console.log(`  Payment:         ${payments} records`);

    console.log('\n✅ System Status:');
    if (feeCategories > 0) console.log('  ✅ Fee categories initialized');
    if (feeAssignments > 0) console.log('  ✅ Fee assignments created');
    if (students > 0) console.log('  ✅ Student data restored');
    if (invoices > 0) console.log('  ✅ Invoice data restored');
    if (payments > 0) console.log('  ✅ Payment data restored');

    console.log('\n📝 Fee Categories:');
    const categories = await prisma.feeCategory.findMany({
      select: { code: true, name: true, isGeneratable: true },
    });
    categories.forEach((cat) => {
      console.log(`  - ${cat.code}: ${cat.name} (generatable: ${cat.isGeneratable})`);
    });

    console.log('\n🎓 Sample Class Assignments:');
    const assignments = await prisma.feeAssignment.findMany({
      take: 5,
      include: { category: true, class: true },
    });
    assignments.forEach((a) => {
      console.log(`  - ${a.class.name}: ${a.category.name} = ${a.amount} BDT`);
    });

    console.log('\n✅ Verification Complete - System Ready!');
  } catch (error) {
    console.error('❌ Error during verification:', error);
  } finally {
    await prisma.$disconnect();
  }
}

verifySystem();
