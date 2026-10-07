import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function clearFinancialData() {
  try {
    console.log('🔄 Starting financial data cleanup...\n');

    // SAFE TO DELETE - Financial/Transaction data only
    const deleteOperations = [
      {
        name: 'LedgerEntry',
        operation: () => prisma.ledgerEntry.deleteMany({}),
        description: 'Income/expense ledger entries'
      },
      {
        name: 'Payment',
        operation: () => prisma.payment.deleteMany({}),
        description: 'Payment records'
      },
      {
        name: 'Invoice',
        operation: () => prisma.invoice.deleteMany({}),
        description: 'Student invoices'
      },
      {
        name: 'InvoiceItem',
        operation: () => prisma.invoiceItem.deleteMany({}),
        description: 'Invoice line items'
      },
      {
        name: 'StudentFee',
        operation: () => prisma.studentFee.deleteMany({}),
        description: 'Student fee records'
      },
      {
        name: 'StudentFeeAssignment',
        operation: () => prisma.studentFeeAssignment.deleteMany({}),
        description: 'Fee assignments'
      },
      {
        name: 'SchoolExpense',
        operation: () => prisma.schoolExpense.deleteMany({}),
        description: 'Expense records'
      },
      {
        name: 'TeacherSalary',
        operation: () => prisma.teacherSalary.deleteMany({}),
        description: 'Teacher salary records'
      },
      {
        name: 'StaffSalary',
        operation: () => prisma.staffSalary.deleteMany({}),
        description: 'Staff salary records'
      },
      {
        name: 'Purchase',
        operation: () => prisma.purchase.deleteMany({}),
        description: 'Store purchases'
      },
      {
        name: 'PurchaseItem',
        operation: () => prisma.purchaseItem.deleteMany({}),
        description: 'Purchase line items'
      },
      {
        name: 'Sale',
        operation: () => prisma.sale.deleteMany({}),
        description: 'Store sales'
      },
      {
        name: 'SaleItem',
        operation: () => prisma.saleItem.deleteMany({}),
        description: 'Sale line items'
      },
      {
        name: 'NumberSequence',
        operation: () => prisma.numberSequence.deleteMany({}),
        description: 'Invoice/payment sequence numbers'
      }
    ];

    // Execute deletions
    let totalDeleted = 0;
    for (const op of deleteOperations) {
      try {
        const result = await op.operation();
        const count = result.count || 0;
        console.log(`✅ ${op.name.padEnd(25)} - Deleted ${count} records (${op.description})`);
        totalDeleted += count;
      } catch (error: any) {
        // Some tables might not exist - that's OK
        if (error.code === 'P1017' || error.message.includes('does not exist')) {
          console.log(`⚠️  ${op.name.padEnd(25)} - Table not found (skipped)`);
        } else {
          console.log(`❌ ${op.name.padEnd(25)} - Error: ${error.message}`);
        }
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log(`✅ TOTAL FINANCIAL RECORDS DELETED: ${totalDeleted}`);
    console.log('='.repeat(70));

    // Verify protected data still exists
    console.log('\n🔍 Verifying protected data...\n');

    const [
      studentCount,
      teacherCount,
      classCount,
      subjectCount,
      examCount,
      resultCount,
      gradingSystemCount
    ] = await Promise.all([
      prisma.student.count(),
      prisma.teacher.count(),
      prisma.schoolClass.count(),
      prisma.subject.count(),
      prisma.exam.count(),
      prisma.result.count(),
      prisma.gradingSystem.count()
    ]);

    console.log(`✅ Students:          ${studentCount} records (PRESERVED)`);
    console.log(`✅ Teachers:          ${teacherCount} records (PRESERVED)`);
    console.log(`✅ Classes:           ${classCount} records (PRESERVED)`);
    console.log(`✅ Subjects:          ${subjectCount} records (PRESERVED)`);
    console.log(`✅ Exams:             ${examCount} records (PRESERVED)`);
    console.log(`✅ Exam Results:      ${resultCount} records (PRESERVED)`);
    console.log(`✅ Grading Systems:   ${gradingSystemCount} records (PRESERVED)`);

    console.log('\n✅ FINANCIAL DATA CLEANUP COMPLETE!');
    console.log('   All student, exam, and marks data is safe.');
    console.log('   Ready for fresh financial records.\n');

  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run with confirmation
console.log('🚨 WARNING: This will DELETE all financial data!');
console.log('   ✅ Students, classes, subjects, exams, marks: PRESERVED');
console.log('   ❌ Invoices, payments, expenses, salaries: DELETED\n');

const args = process.argv.slice(2);

// Two independent gates. --confirm alone is easy to paste by reflex, and this
// script issues unconditional deleteMany({}) against whichever DATABASE_URL is
// active, so pointing it at production would wipe the ledger. The env var has to
// be set deliberately in the environment too.
const confirmed = args.includes('--confirm');
const armed = process.env.ALLOW_FINANCIAL_PURGE === '1';

if (confirmed && !armed) {
  console.log('Refusing to run: also set ALLOW_FINANCIAL_PURGE=1 in the environment.');
  console.log('This guards against wiping the live ledger by accident.');
} else if (!confirmed) {
  console.log('To proceed, run: npx ts-node clear-financial-data.ts --confirm');
  console.log('...with ALLOW_FINANCIAL_PURGE=1 set in the environment.');
} else {
  clearFinancialData();
}
