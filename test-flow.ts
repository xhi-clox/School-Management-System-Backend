import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function testFlow() {
  console.log('=== STEP 1: Check database connection ===');
  const count = await prisma.student.count();
  console.log(`Students in DB: ${count}`);

  console.log('\n=== STEP 2: Get an admission package ===');
  const pkg = await prisma.admissionPackage.findFirst({ include: { feeItems: true, class: true } });
  if (!pkg) {
    console.error('No admission packages found!');
    return;
  }
  console.log(`Package: ${pkg.name} (${pkg.id})`);
  console.log(`Class ID: ${pkg.classId}`);
  console.log(`Fee items: ${pkg.feeItems.length}`);

  console.log('\n=== STEP 3: Create admission via backend API ===');
  const payload = {
    student: {
      name: 'Test Student Flow',
      classId: pkg.classId,
      gender: 'Male',
    },
    guardian: {
      fatherName: 'Test Father',
    },
    packageId: pkg.id
  };

  const postRes = await fetch('http://localhost:4000/students/admission', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  console.log(`POST status: ${postRes.status}`);
  const postText = await postRes.text();
  console.log(`POST response: ${postText}`);
  
  if (!postRes.ok) {
    console.error('Admission FAILED');
    return;
  }

  const postData = JSON.parse(postText);
  const invoiceId = postData.invoice?.id;
  console.log(`Invoice ID: ${invoiceId}`);

  console.log('\n=== STEP 4: Fetch invoice directly from backend ===');
  const getRes = await fetch(`http://localhost:4000/invoices/${invoiceId}`);
  console.log(`GET status: ${getRes.status}`);
  const getBody = await getRes.text();
  console.log(`GET body: ${getBody.substring(0, 300)}`);

  console.log('\n=== STEP 5: Check DB directly ===');
  const dbInvoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  console.log(`DB lookup: ${dbInvoice ? 'FOUND' : 'NOT FOUND'}`);

  const allInvoices = await prisma.invoice.findMany({ take: 5, orderBy: { createdAt: 'desc' } });
  console.log(`Recent invoices in DB: ${allInvoices.length}`);
  allInvoices.forEach(inv => console.log(`  ${inv.id} | ${inv.status} | ${inv.totalAmount}`));

  await prisma.$disconnect();
}

testFlow().catch(e => { console.error(e); prisma.$disconnect(); });
