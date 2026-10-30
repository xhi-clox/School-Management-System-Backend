import { execSync } from 'child_process';

/**
 * HTTP smoke test for the new fee endpoints.
 * Uses a throwaway ZZ_SMOKE_* category on a 2099 billing period so it is safe
 * to run repeatedly and easy to identify for cleanup.
 */

const BASE = 'http://localhost:4000/fees';

function token(): string {
  const out = execSync('npx ts-node scripts/mint-test-token.ts', {
    encoding: 'utf8',
    cwd: __dirname + '/..',
  });
  return out.trim().split(/\r?\n/).pop() as string;
}

let AUTH = '';

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AUTH}`,
    },
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

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

async function main() {
  AUTH = token();
  console.log('--- auth ---');
  const me = await call('GET', '/categories');
  check('GET /categories returns seeded defaults', me.status === 200 && Array.isArray(me.data?.categories ?? me.data) && (me.data?.categories ?? me.data).length >= 8, me.data);

  const list = me.data?.categories ?? me.data;
  const tuition = list.find((c: any) => c.code === 'TUITION');

  console.log('\n--- category CRUD over HTTP ---');
  const created = await call('POST', '/categories', {
    code: 'ZZ_SMOKE',
    name: 'ZZ Smoke Fee',
    description: 'temporary smoke test category',
    isRecurring: false,
    frequency: 'once',
    isGeneratable: false,
    isActive: true,
  });
  check('POST /categories creates category', created.status === 200 || created.status === 201, created.data);
  const catId = created.data?.category?.id ?? created.data?.id;

  const dup = await call('POST', '/categories', { code: 'ZZ_SMOKE', name: 'Duplicate attempt' });
  check('duplicate category code rejected', dup.status >= 400, { status: dup.status, data: dup.data });

  const patch = await call('PUT', `/categories/${catId}`, { description: 'updated description' });
  check('PUT /categories/:id updates', (patch.status === 200 || patch.status === 201) && JSON.stringify(patch.data).includes('updated description'), patch.data);

  console.log('\n--- records + generation over HTTP ---');
  const students = await call('GET', '/records?studentId=__none__');
  check('GET /records responds', students.status === 200, students.data);

  const missingAssign = await call('POST', '/generate', {
    categoryId: catId,
    billingPeriod: '2099-01',
    preview: true,
  });
  check('preview without assignment reports missing', missingAssign.status === 200 && missingAssign.data?.mode === 'preview', missingAssign.data);

  const preview = missingAssign.data?.preview;
  check('preview reports toGenerate of 0', preview?.toGenerate === 0, preview);
  check('preview reports all students as missing an assignment', preview?.missingAssignments === 112, preview?.missingAssignments);
  check('preview lists excluded students with reasons', (preview?.missingRows?.length ?? 0) > 0, preview?.missingRows?.length);
  check('preview total is zero', Number(preview?.totalAmount) === 0, preview?.totalAmount);

  console.log('\n--- manual record + duplicate over HTTP ---');
  const studentsRes = await fetch(`${process.env.SMS_BASE ?? 'http://localhost:4000'}/students`, {
    headers: { Authorization: `Bearer ${AUTH}` },
  });
  const studentsBody = await studentsRes.json();
  const anyStudent = (studentsBody?.students ?? studentsBody)?.[0];
  check('found a student to bill', !!anyStudent?.id, studentsBody?.message ?? 'no students');

  const manual = await call('POST', '/records', {
    studentId: anyStudent.id,
    categoryId: catId,
    billingPeriod: '2099-01',
    amount: 750,
    notes: 'smoke test record',
  });
  check('POST /records accepts explicit amount', manual.status === 200 || manual.status === 201, manual.data);
  const record = manual.data?.record ?? manual.data;
  check('assignmentAmount is null without a class rule', record?.assignmentAmount === null, record?.assignmentAmount);

  const manualDup = await call('POST', '/records', {
    studentId: anyStudent.id,
    categoryId: catId,
    billingPeriod: '2099-01',
    amount: 750,
  });
  check('duplicate manual record blocked with 409', manualDup.status === 409, { status: manualDup.status, data: manualDup.data });

  console.log('\n--- override over HTTP ---');
  const override = await call('POST', `/students/${anyStudent.id}/overrides`, {
    categoryId: catId,
    billingPeriod: '2099-01',
    overrideType: 'waive',
    overrideReason: 'smoke test waiver',
  });
  check('POST override creates waiver', (override.status === 200 || override.status === 201), override.data);

  const overrideList = await call('GET', `/students/${anyStudent.id}/overrides`);
  check('GET overrides lists it', overrideList.status === 200, overrideList.data);

  const overrideId = override.data?.override?.id ?? override.data?.id;
  const overrideDelete = await call('DELETE', `/students/${anyStudent.id}/overrides/${overrideId}`);
  check('DELETE override removes it', overrideDelete.status === 200 || overrideDelete.status === 204, overrideDelete.data);

  console.log('\n--- validation over HTTP ---');
  const badPeriod = await call('POST', '/generate', { categoryId: catId, billingPeriod: 'Oct 2026', preview: true });
  check('invalid billing period rejected', badPeriod.status >= 400, { status: badPeriod.status, data: badPeriod.data });

  const badCategory = await call('POST', '/records', {
    studentId: anyStudent.id,
    categoryId: 'does-not-exist',
    billingPeriod: '2099-01',
    amount: 100,
  });
  check('unknown category rejected', badCategory.status >= 400, { status: badCategory.status, data: badCategory.data });

  const unauth = await fetch(`${BASE}/categories`);
  check('unauthenticated request is 401', unauth.status === 401, unauth.status);

  console.log('\n--- non-generatable category blocked from bulk run ---');
  const blocked = await call('POST', '/generate', {
    categoryId: catId,
    billingPeriod: '2099-01',
  });
  check('bulk run on non-generatable blocked', blocked.status >= 400, { status: blocked.status, data: blocked.data });

  console.log(`\n${pass} passed, ${fail} failed`);

  await cleanup();
  if (fail > 0) process.exitCode = 1;
}

/** Removes everything this script created so it can be run repeatedly. */
async function cleanup() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const cats = await prisma.feeCategory.findMany({
      where: { code: { startsWith: 'ZZ_SMOKE' } },
      select: { id: true },
    });
    const catIds = cats.map((c) => c.id);
    const records = await prisma.feeRecord.deleteMany({
      where: { billingPeriod: '2099-01', categoryId: { in: catIds } },
    });
    const overrides = await prisma.studentFeeOverride.deleteMany({
      where: { categoryId: { in: catIds } },
    });
    const removed = await prisma.feeCategory.deleteMany({
      where: { code: { startsWith: 'ZZ_SMOKE' } },
    });
    console.log(
      `cleanup: removed ${removed.count} categories, ${records.count} records, ${overrides.count} overrides`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});