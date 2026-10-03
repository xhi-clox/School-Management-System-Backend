import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

/**
 * End-to-end check for the FeeRecord -> Invoice bridge.
 *
 * A category FeeRecord has to be collectable through the ordinary payment flow,
 * because that is what the Student Fees page is built from. This walks the real
 * journey an admin takes — price a class, generate the month, find the row on the
 * Student Fees page, collect part of it, then the rest — and asserts the money and
 * the record status stay in step at every step.
 *
 * Uses a throwaway ZZ_BRIDGE_* category on a 2099 billing period and cleans up
 * after itself.
 */

const prisma = new PrismaClient();
const BASE = 'http://localhost:4000';
const PERIOD = '2099-03';
const CODE = 'ZZ_BRIDGE';

let AUTH = '';
let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function cleanup() {
  const category = await prisma.feeCategory.findUnique({ where: { code: CODE } });
  if (!category) return;
  const records = await prisma.feeRecord.findMany({
    where: { categoryId: category.id },
    select: { id: true },
  });
  const ids = records.map((r) => r.id);
  await prisma.payment.deleteMany({ where: { feeRecordId: { in: ids } } });
  await prisma.ledgerEntry.deleteMany({ where: { feeRecordId: { in: ids } } });
  await prisma.invoice.deleteMany({ where: { migrationFeeRecordId: { in: ids } } });
  await prisma.studentFeeOverride.deleteMany({ where: { categoryId: category.id } });
  await prisma.feeAssignment.deleteMany({ where: { categoryId: category.id } });
  await prisma.feeRecord.deleteMany({ where: { categoryId: category.id } });
  await prisma.feeCategory.delete({ where: { id: category.id } });
}

async function main() {
  AUTH = execSync('npx ts-node scripts/mint-test-token.ts', {
    encoding: 'utf8',
    cwd: __dirname + '/..',
  })
    .trim()
    .split(/\r?\n/)
    .pop() as string;

  console.log(`classes=${(await prisma.schoolClass.count())} students=${(await prisma.student.count())}\n`);
  await cleanup();

  const klass = await prisma.schoolClass.findFirst({ orderBy: { name: 'asc' } });
  if (!klass) throw new Error('no SchoolClass rows to test against');

  const studentsInClass = await prisma.student.findMany({
    where: { class: klass.name, section: klass.section, status: 'Active' },
    select: { id: true, name: true },
  });
  if (studentsInClass.length === 0) throw new Error('no active students in the first class');

  console.log('[1] price the class');
  const created = await call('POST', '/fees/categories', {
    name: 'ZZ Bridge Category',
    code: CODE,
    frequency: 'monthly',
    isRecurring: true,
    isGeneratable: true,
  });
  check('category created', created.status === 201, `status ${created.status}`);
  const categoryId = created.data?.category?.id ?? created.data?.id;

  const assign = await call('POST', '/fees/assignments', {
    categoryId,
    classId: klass.id,
    amount: 1234.5,
  });
  check('assignment created', assign.status === 201, `status ${assign.status}`);

  console.log('\n[2] generate the month');
  const gen = await call('POST', '/fees/generate', { categoryId, billingPeriod: PERIOD });
  check('generation accepted', gen.status === 200, `status ${gen.status}`);
  const createdCount = gen.data?.result?.created ?? 0;
  check('records were created', createdCount === studentsInClass.length, `created=${createdCount} expected=${studentsInClass.length}`);

  const nonActiveAll = await prisma.student.count({ where: { NOT: { status: 'Active' } } });
  const previewInactive = (await call('POST', '/fees/generate', { categoryId, billingPeriod: PERIOD, preview: true }))
    .data?.preview?.inactive ?? -1;
  // The preview is not class-scoped here, so it reports every non-Active student.
  check(
    'preview reports every non-active student',
    previewInactive === nonActiveAll,
    `preview.inactive=${previewInactive} dbNonActive=${nonActiveAll}`,
  );
  const billedNonActive = await prisma.feeRecord.count({
    where: { categoryId, billingPeriod: PERIOD, student: { NOT: { status: 'Active' } } },
  });
  check('no inactive student was billed', billedNonActive === 0, `billed ${billedNonActive} inactive students`);

  console.log('\n[3] the charge is now a row on the Student Fees page');
  // GET /invoices is the only thing that page reads, so presence here *is* visibility.
  const invoices = await call('GET', `/invoices?limit=100`);
  const rows: any[] = Array.isArray(invoices.data) ? invoices.data : (invoices.data?.data ?? []);
  const mine = rows.filter((r) => studentsInClass.some((s) => s.id === r.studentId));
  check('bridged invoices are listed', mine.length === studentsInClass.length, `found ${mine.length}`);

  const sample = mine[0];
  check('invoice links to its fee record', Boolean(sample?.migrationFeeRecordId), 'migrationFeeRecordId missing');
  check('invoice carries the category name', sample?.items?.[0]?.name === 'ZZ Bridge Category', `got ${sample?.items?.[0]?.name}`);
  check('invoice total matches the class price', Number(sample?.totalAmount) === 1234.5, `got ${sample?.totalAmount}`);
  check('invoice is billed for the month', sample?.billingMonth === PERIOD, `got ${sample?.billingMonth}`);
  check('invoice is unpaid', sample?.status === 'unpaid', `got ${sample?.status}`);
  check('full balance is due', Number(sample?.balance) === 1234.5, `got ${sample?.balance}`);
  check('invoice has a real invoice number', /^INV-\d{4}-ADM-\d{5}$|^INV-/.test(String(sample?.invoiceNo)), `got ${sample?.invoiceNo}`);

  console.log('\n[4] collect part of it');
  const pay = await call('POST', '/payments', {
    invoiceId: sample.id,
    amount: 500,
    method: 'cash',
  });
  check('payment accepted', pay.status === 201 || pay.status === 200, `status ${pay.status}`);

  const recAfterPart = await prisma.feeRecord.findUnique({
    where: { id: sample.migrationFeeRecordId },
    select: { status: true, amount: true },
  });
  check('record is now partial', recAfterPart?.status === 'partial', `got ${recAfterPart?.status}`);

  const invAfterPart = await prisma.invoice.findUnique({
    where: { id: sample.id },
    select: { status: true, paidAmount: true },
  });
  check('invoice is now partial too', invAfterPart?.status === 'partial', `got ${invAfterPart?.status}`);
  check('paid amount tracked', Number(invAfterPart?.paidAmount) === 500, `got ${invAfterPart?.paidAmount}`);

  console.log('\n[5] collect the rest');
  const pay2 = await call('POST', '/payments', {
    invoiceId: sample.id,
    amount: 734.5,
    method: 'cash',
  });
  check('second payment accepted', pay2.status === 201 || pay2.status === 200, `status ${pay2.status}`);

  const recAfterAll = await prisma.feeRecord.findUnique({
    where: { id: sample.migrationFeeRecordId },
    select: { status: true },
  });
  check('record is now paid', recAfterAll?.status === 'paid', `got ${recAfterAll?.status}`);

  console.log('\n[6] deleting a collected record is refused');
  const del = await call('DELETE', `/fees/records/${sample.migrationFeeRecordId}`);
  check('delete refused with 409', del.status === 409, `status ${del.status}`);

  console.log('\n[7] a waived fee is never made collectable');
  // No validFrom: a future validFrom is correctly treated as "not active yet".
  const waiver = await call('POST', '/fees/students/' + studentsInClass[0].id + '/overrides', {
    categoryId,
    overrideAmount: 0,
    overrideReason: 'ZZ Bridge full waiver',
  });
  check('override accepted', waiver.status === 201 || waiver.status === 200, `status ${waiver.status}`);

  const manual = await call('POST', '/fees/records', {
    studentId: studentsInClass[0].id,
    categoryId,
    billingPeriod: '2099-04',
    source: 'manual',
  });
  check('second-period record created', manual.status === 201 || manual.status === 200, `status ${manual.status}`);
  const manualId = manual.data?.record?.id ?? manual.data?.id;
  const manualRec = manualId
    ? await prisma.feeRecord.findUnique({ where: { id: manualId }, select: { status: true, amount: true } })
    : null;
  check('overridden record is waived', manualRec?.status === 'waived', `got ${manualRec?.status}`);
  const waivedInvoice = manualId
    ? await prisma.invoice.findFirst({ where: { migrationFeeRecordId: manualId } })
    : null;
  check('waived record gets no invoice', waivedInvoice === null, 'an invoice was created for a waived fee');

  console.log('\n[8] manual creation is bridged too');
  // A different student: the first one now carries a standing waiver.
  const manualOk = await call('POST', '/fees/records', {
    studentId: studentsInClass[1].id,
    categoryId,
    billingPeriod: '2099-05',
    source: 'manual',
    amount: 999,
    allowMissingAssignment: false,
  });
  check('manual record accepted', manualOk.status === 201 || manualOk.status === 200, `status ${manualOk.status}`);
  const manualOkId = manualOk.data?.record?.id ?? manualOk.data?.id;
  const bridged = manualOkId
    ? await prisma.invoice.findFirst({
        where: { migrationFeeRecordId: manualOkId },
        include: { items: true },
      })
    : null;
  check('manual record has an invoice', bridged !== null);
  check('manual invoice total is the charged amount', Number(bridged?.totalAmount) === 999, `got ${bridged?.totalAmount}`);
  check('manual invoice is numbered', /^INV-/.test(String(bridged?.invoiceNo)), `got ${bridged?.invoiceNo}`);

  console.log('\n[9] one invoice per record');
  const dupCount = manualOkId
    ? await prisma.invoice.count({ where: { migrationFeeRecordId: manualOkId } })
    : 0;
  check('exactly one invoice per record', dupCount === 1, `found ${dupCount}`);

  console.log(`\n${pass} checks passed, ${fail} failed.`);
  await cleanup();
  const left = await prisma.feeCategory.count({ where: { code: CODE } });
  const leftRecords = await prisma.feeRecord.count({ where: { billingPeriod: { startsWith: '2099-' } } });
  console.log(`cleanup: ${left} test categories, ${leftRecords} 2099 test records remaining`);
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch(async (e) => {
    console.error(e);
    await cleanup();
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());