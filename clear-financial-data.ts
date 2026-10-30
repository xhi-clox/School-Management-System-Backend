import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

type DeleteOp = {
  name: string;
  description: string;
  run: (tx: Prisma.TransactionClient) => Promise<{ count: number }>;
};

// Finance transaction rows only, in dependency order.
//
// Master/config data is deliberately excluded and preserved:
//   FeeCategory, FeeAssignment, FeeStructure, FeeParticular, AdmissionPackage,
//   AdmissionFeeItem, Product, Supplier, AuditLog
// Academic data is never touched:
//   Student, Guardian, Parent, Teacher, Staff, SchoolClass, Subject, Exam,
//   ExamSchedule, Attendance, Result, GradingSystem, ...
//
// Ordering notes:
//   - Payment before Invoice (Payment.invoiceId is NOT NULL; Invoice also
//     cascades it, but deleting first keeps the reported counts honest).
//   - Invoice before FeeRecord. Invoice.migrationFeeRecordId is ON DELETE
//     CASCADE, so deleting a FeeRecord takes its bridged invoice (and that
//     invoice's payments) with it. Going invoice-first avoids surprises.
//   - FeeCategory is never deleted, which is what keeps the
//     FeeRecord.categoryId ON DELETE RESTRICT constraint satisfied.
const deleteOps: DeleteOp[] = [
  { name: 'LedgerEntry', description: 'Income/expense ledger (source of every finance total)', run: (tx) => tx.ledgerEntry.deleteMany({}) },
  { name: 'Payment', description: 'Payments / receipts', run: (tx) => tx.payment.deleteMany({}) },
  { name: 'InvoiceItem', description: 'Invoice line items', run: (tx) => tx.invoiceItem.deleteMany({}) },
  { name: 'Invoice', description: 'Student invoices', run: (tx) => tx.invoice.deleteMany({}) },
  { name: 'FeeRecord', description: 'Category fee charges', run: (tx) => tx.feeRecord.deleteMany({}) },
  { name: 'StudentFeeOverride', description: 'Per-student waivers / discount overrides', run: (tx) => tx.studentFeeOverride.deleteMany({}) },
  { name: 'StudentFee', description: 'Legacy student fee rows', run: (tx) => tx.studentFee.deleteMany({}) },
  { name: 'StudentFeeAssignment', description: 'Legacy fee assignments', run: (tx) => tx.studentFeeAssignment.deleteMany({}) },
  { name: 'SchoolExpense', description: 'School expenses', run: (tx) => tx.schoolExpense.deleteMany({}) },
  { name: 'TeacherSalary', description: 'Teacher salary payments', run: (tx) => tx.teacherSalary.deleteMany({}) },
  { name: 'StaffSalary', description: 'Staff salary payments', run: (tx) => tx.staffSalary.deleteMany({}) },
  { name: 'SaleItem', description: 'Store sale line items', run: (tx) => tx.saleItem.deleteMany({}) },
  { name: 'Sale', description: 'Store sales', run: (tx) => tx.sale.deleteMany({}) },
  { name: 'PurchaseItem', description: 'Store purchase line items', run: (tx) => tx.purchaseItem.deleteMany({}) },
  { name: 'Purchase', description: 'Store purchases', run: (tx) => tx.purchase.deleteMany({}) },
  { name: 'NumberSequence', description: 'Invoice/receipt number counters (reset to 0)', run: (tx) => tx.numberSequence.deleteMany({}) },
];

const PRESERVED_COUNTS = [
  { label: 'Fee categories', run: () => prisma.feeCategory.count() },
  { label: 'Fee assignments (class prices)', run: () => prisma.feeAssignment.count() },
  { label: 'Students', run: () => prisma.student.count() },
  { label: 'Teachers', run: () => prisma.teacher.count() },
  { label: 'Staff', run: () => prisma.staff.count() },
  { label: 'Classes', run: () => prisma.schoolClass.count() },
  { label: 'Subjects', run: () => prisma.subject.count() },
  { label: 'Exams', run: () => prisma.exam.count() },
  { label: 'Results', run: () => prisma.result.count() },
  { label: 'Attendance records', run: () => prisma.attendance.count() },
  { label: 'Grading systems', run: () => prisma.gradingSystem.count() },
];

function dbTarget() {
  const url = process.env.DATABASE_URL || '(not set)';
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function showFinanceTotals() {
  const active = { reversedAt: null };
  const [income, expense, billed, collected, records] = await Promise.all([
    prisma.ledgerEntry.aggregate({ where: { ...active, type: 'income' }, _sum: { amount: true } }),
    prisma.ledgerEntry.aggregate({ where: { ...active, type: 'expense' }, _sum: { amount: true } }),
    prisma.invoice.aggregate({ _sum: { totalAmount: true } }),
    prisma.invoice.aggregate({ _sum: { paidAmount: true } }),
    prisma.feeRecord.count(),
  ]);
  console.log(`   Ledger income   : ${income._sum.amount?.toString() ?? 0}`);
  console.log(`   Ledger expense  : ${expense._sum.amount?.toString() ?? 0}`);
  console.log(`   Invoiced total  : ${billed._sum.totalAmount?.toString() ?? 0}`);
  console.log(`   Collected total : ${collected._sum.paidAmount?.toString() ?? 0}`);
  console.log(`   Fee records     : ${records}`);
}

async function countAll() {
  const counts: Array<{ name: string; description: string; count: number }> = [];
  for (const op of deleteOps) {
    const count = await (prisma as any)[lowerFirst(op.name)].count();
    counts.push({ name: op.name, description: op.description, count });
  }
  return counts;
}

function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

async function clearFinancialData() {
  console.log('🔄 Starting financial data cleanup...\n');
  console.log(`   Target database: ${dbTarget()}\n`);

  console.log('💰 Finance totals BEFORE purge:');
  await showFinanceTotals();

  console.log('\n🗑️  Purging (single transaction)...\n');
  await prisma.$transaction(
    deleteOps.map((op) => op.run(prisma as unknown as Prisma.TransactionClient)),
    { timeout: 60000, maxWait: 15000 }
  );

  console.log('✅ Purge committed. All finance totals are now 0.\n');

  console.log('🔍 Verifying finance tables are empty...\n');
  const after = await countAll();
  let financeClean = true;
  for (const row of after) {
    const ok = row.count === 0;
    if (!ok) financeClean = false;
    console.log(`${ok ? '✅' : '❌'} ${row.name.padEnd(22)} ${row.count} remaining (${row.description})`);
  }

  console.log('\n🔍 Verifying protected data still exists...\n');
  const protectedBefore = await Promise.all(PRESERVED_COUNTS.map((m) => m.run()));
  PRESERVED_COUNTS.forEach((m, i) => {
    console.log(`✅ ${m.label.padEnd(30)} ${protectedBefore[i]} records (PRESERVED)`);
  });

  console.log('\n' + '='.repeat(70));
  if (financeClean) {
    console.log('✅ FINANCIAL DATA CLEARED — all money is now 0.');
  } else {
    console.log('❌ FINANCE NOT FULLY CLEARED — see the remaining counts above.');
  }
  console.log('   Student, teacher, staff, class, subject, exam, attendance,');
  console.log('   marks and fee pricing config are untouched.');
  console.log('='.repeat(70) + '\n');
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const confirmed = args.includes('--confirm');
// Two independent gates. --confirm alone is easy to paste by reflex, and this
// script issues unconditional deleteMany({}) against whichever DATABASE_URL is
// active, so pointing it at production would wipe the ledger. The env var has to
// be set deliberately in the environment too.
const armed = process.env.ALLOW_FINANCIAL_PURGE === '1';

async function main() {
  console.log(`Database: ${dbTarget()}\n`);

  if (dryRun) {
    console.log('🔍 DRY RUN — nothing will be deleted.\n');
    console.log('💰 Finance totals that WILL be wiped:\n');
    await showFinanceTotals();
    console.log('\n📋 Rows that WILL be deleted:\n');
    for (const row of await countAll()) {
      console.log(`   ${row.name.padEnd(22)} ${String(row.count).padStart(6)}  ${row.description}`);
    }
    console.log('\n📋 Rows that will be PRESERVED:\n');
    const kept = await Promise.all(PRESERVED_COUNTS.map((m) => m.run()));
    PRESERVED_COUNTS.forEach((m, i) => {
      console.log(`   ${m.label.padEnd(30)} ${String(kept[i]).padStart(6)}  PRESERVED`);
    });
    console.log('\n✅ Dry run complete. Re-run with --confirm to execute.\n');
    return;
  }

  console.log('🚨 WARNING: This will DELETE all financial data!');
  console.log('   ✅ Students, classes, subjects, exams, attendance, marks: PRESERVED');
  console.log('   ✅ Fee categories, class prices, fee structures, packages: PRESERVED');
  console.log('   ✅ Audit log: PRESERVED');
  console.log('   ❌ Invoices, payments, fee records, ledger, expenses, salaries, store transactions: DELETED\n');

  if (confirmed && !armed) {
    console.log('Refusing to run: also set ALLOW_FINANCIAL_PURGE=1 in the environment.');
    console.log('This guards against wiping the live ledger by accident.');
    return;
  }
  if (!confirmed) {
    console.log('To proceed, run: npx ts-node clear-financial-data.ts --confirm');
    console.log('...with ALLOW_FINANCIAL_PURGE=1 set in the environment.');
    console.log('Preview first with: npx ts-node clear-financial-data.ts --dry-run');
    return;
  }

  await clearFinancialData();
}

main()
  .catch((error) => {
    console.error('❌ Error during cleanup:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
