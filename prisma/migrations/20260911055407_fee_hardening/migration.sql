-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "academicYear" TEXT,
ADD COLUMN     "invoiceNo" TEXT;

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "paymentId" TEXT,
ADD COLUMN     "studentId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "paymentNo" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedBy" TEXT;

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "actor" TEXT,
    "reason" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NumberSequence" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NumberSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NumberSequence_scope_key" ON "NumberSequence"("scope");

-- CreateIndex
CREATE INDEX "Invoice_type_billingMonth_idx" ON "Invoice"("type", "billingMonth");

-- CreateIndex
CREATE INDEX "Invoice_studentId_billingMonth_idx" ON "Invoice"("studentId", "billingMonth");

-- CreateIndex
CREATE INDEX "LedgerEntry_date_idx" ON "LedgerEntry"("date");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_status_idx" ON "Payment"("invoiceId", "status");

-- Backfill: LedgerEntry.date should mirror its original createdAt for accurate daily reports.
UPDATE "LedgerEntry" SET "date" = "createdAt";

-- Backfill: derive academicYear ('2026-27') from billingMonth (BD school year starts July).
-- Fallback to createdAt for invoices without a billingMonth.
UPDATE "Invoice"
SET "academicYear" = CASE
    WHEN "billingMonth" IS NOT NULL THEN
        CASE WHEN CAST(SUBSTRING("billingMonth" FROM 6 FOR 2) AS INT) >= 7
             THEN SUBSTRING("billingMonth" FROM 1 FOR 4) || '-' || LPAD(((CAST(SUBSTRING("billingMonth" FROM 1 FOR 4) AS INT) + 1) % 100)::text, 2, '0')
             ELSE LPAD(((CAST(SUBSTRING("billingMonth" FROM 1 FOR 4) AS INT) - 1) % 100)::text, 2, '0') || '-' || SUBSTRING("billingMonth" FROM 1 FOR 4)
        END
    ELSE
        CASE WHEN EXTRACT(MONTH FROM "createdAt") >= 7
             THEN EXTRACT(YEAR FROM "createdAt")::text || '-' || LPAD(((EXTRACT(YEAR FROM "createdAt") + 1) % 100)::int::text, 2, '0')
             ELSE LPAD(((EXTRACT(YEAR FROM "createdAt") - 1) % 100)::int::text, 2, '0') || '-' || EXTRACT(YEAR FROM "createdAt")::text
        END
END;

-- Dedupe tuition invoices generated for the same student in the same billingMonth.
-- Keep the earliest, migrate its payments/ledger references, then delete the rest.
CREATE TEMP TABLE tuition_ranked AS (
    SELECT * FROM (
        SELECT id, "studentId", "billingMonth",
               ROW_NUMBER() OVER (PARTITION BY "studentId", "billingMonth" ORDER BY "createdAt" ASC, id ASC) AS rn
        FROM "Invoice"
        WHERE type = 'tuition' AND "billingMonth" IS NOT NULL
    ) sub
);

UPDATE "Payment" p
SET "invoiceId" = c.id
FROM tuition_ranked d
JOIN tuition_ranked c ON c."studentId" = d."studentId" AND c."billingMonth" = d."billingMonth" AND c.rn = 1
WHERE d.rn > 1 AND p."invoiceId" = d.id;

UPDATE "LedgerEntry" l
SET "referenceInvoice" = c.id, "studentId" = c."studentId"
FROM tuition_ranked d
JOIN tuition_ranked c ON c."studentId" = d."studentId" AND c."billingMonth" = d."billingMonth" AND c.rn = 1
WHERE d.rn > 1 AND l."referenceInvoice" = d.id;

DELETE FROM "Invoice" WHERE id IN (SELECT id FROM tuition_ranked WHERE rn > 1);
DROP TABLE tuition_ranked;

-- Backfill: recalc paidAmount/status as the single source of truth from active payments.
UPDATE "Invoice" inv
SET "paidAmount" = COALESCE(pay.total, 0),
    status = CASE
        WHEN COALESCE(pay.total, 0) >= inv."totalAmount" THEN 'paid'
        WHEN COALESCE(pay.total, 0) > 0 THEN 'partial'
        ELSE 'unpaid'
    END
FROM (
    SELECT "invoiceId", SUM(amount) AS total
    FROM "Payment" WHERE status = 'active'
    GROUP BY "invoiceId"
) pay
WHERE inv.id = pay."invoiceId";

-- Backfill: invoiceNo / paymentNo for existing records.
WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, id ASC) AS n
    FROM "Invoice"
)
UPDATE "Invoice" i
SET "invoiceNo" = 'INV-' || COALESCE(i."academicYear", '----') || '-' || LPAD(numbered.n::text, 5, '0')
FROM numbered WHERE i.id = numbered.id;

WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, id ASC) AS n
    FROM "Payment"
)
UPDATE "Payment" p
SET "paymentNo" = 'REC-' || COALESCE((SELECT i."academicYear" FROM "Invoice" i WHERE i.id = p."invoiceId"), '----') || '-' || LPAD(numbered.n::text, 5, '0')
FROM numbered WHERE p.id = numbered.id;

-- Backfill: LedgerEntry.studentId from its referenced invoice (paymentId stays NULL for legacy rows).
UPDATE "LedgerEntry" l
SET "studentId" = i."studentId"
FROM "Invoice" i
WHERE l."referenceInvoice" = i.id AND l."studentId" IS NULL;

-- Enforce monthly-tuition idempotency at the database level (even under concurrent requests).
CREATE UNIQUE INDEX "Invoice_studentId_billingMonth_tuition_key"
ON "Invoice"("studentId", "billingMonth")
WHERE type = 'tuition';
