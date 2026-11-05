import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Check = { name: string; rows: any[] };

async function main() {
  const checks: Check[] = [];

  checks.push({
    name: 'FeeRecords with a balance but no collectable Invoice',
    rows: await prisma.$queryRawUnsafe(`
      SELECT fr.id, fr."studentId", fr."categoryId", fr."billingPeriod", fr.amount, fr.status
      FROM "FeeRecord" fr
      LEFT JOIN "Invoice" i ON i."migrationFeeRecordId" = fr.id
      WHERE fr.amount > 0 AND fr.status <> 'waived' AND i.id IS NULL
    `),
  });

  checks.push({
    name: 'Invoices whose paidAmount disagrees with active payments',
    rows: await prisma.$queryRawUnsafe(`
      SELECT i.id, i."invoiceNo", i."totalAmount", i."paidAmount",
             COALESCE(SUM(p.amount) FILTER (WHERE p.status IS NULL OR p.status = 'active'), 0) AS active_paid
      FROM "Invoice" i
      LEFT JOIN "Payment" p ON p."invoiceId" = i.id
      GROUP BY i.id
      HAVING i."paidAmount" <> COALESCE(SUM(p.amount) FILTER (WHERE p.status IS NULL OR p.status = 'active'), 0)
    `),
  });

  checks.push({
    name: 'FeeRecords whose status disagrees with their payments',
    rows: await prisma.$queryRawUnsafe(`
      SELECT fr.id, fr."studentId", fr."billingPeriod", fr.amount, fr.status,
             COALESCE(SUM(p.amount) FILTER (WHERE p.status IS NULL OR p.status = 'active'), 0) AS active_paid
      FROM "FeeRecord" fr
      LEFT JOIN "Payment" p ON p."feeRecordId" = fr.id
      GROUP BY fr.id
      HAVING fr.status <> CASE
          WHEN fr.amount <= 0 THEN 'waived'
          WHEN COALESCE(SUM(p.amount) FILTER (WHERE p.status IS NULL OR p.status = 'active'), 0) >= fr.amount THEN 'paid'
          WHEN COALESCE(SUM(p.amount) FILTER (WHERE p.status IS NULL OR p.status = 'active'), 0) > 0 THEN 'partial'
          ELSE 'due'
      END
    `),
  });

  checks.push({
    name: 'Duplicate invoice numbers',
    rows: await prisma.$queryRawUnsafe(`
      SELECT "invoiceNo", COUNT(*)::int AS n FROM "Invoice"
      WHERE "invoiceNo" IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1
    `),
  });

  checks.push({
    name: 'Duplicate payment numbers',
    rows: await prisma.$queryRawUnsafe(`
      SELECT "paymentNo", COUNT(*)::int AS n FROM "Payment"
      WHERE "paymentNo" IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1
    `),
  });

  checks.push({
    name: 'Negative invoice, payment or fee-record amounts',
    rows: await prisma.$queryRawUnsafe(`
      SELECT 'Invoice' AS source, id, "totalAmount" AS amount FROM "Invoice" WHERE "totalAmount" < 0
      UNION ALL
      SELECT 'Payment', id, amount FROM "Payment" WHERE amount < 0
      UNION ALL
      SELECT 'FeeRecord', id, amount FROM "FeeRecord" WHERE amount < 0
    `),
  });

  checks.push({
    name: 'Unreversed income booked without a Payment row',
    rows: await prisma.$queryRawUnsafe(`
      SELECT id, category, amount, "feeRecordId", "referenceInvoice"
      FROM "LedgerEntry"
      WHERE type = 'income' AND "paymentId" IS NULL AND "reversedAt" IS NULL
    `),
  });

  let failed = false;
  for (const check of checks) {
    if (check.rows.length === 0) {
      console.log(`OK   ${check.name}`);
    } else {
      failed = true;
      console.log(`FAIL ${check.name}: ${check.rows.length}`);
      for (const row of check.rows.slice(0, 20)) console.log('     ', JSON.stringify(row));
    }
  }

  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
