-- H6: configurable monthly due day on the school profile.
ALTER TABLE "Institute" ADD COLUMN "dueDay" INTEGER NOT NULL DEFAULT 10;

-- H1: one override may now apply to many fee records, and each record keeps an
-- immutable copy of the reason so deleting the override cannot erase why money
-- was reduced.
ALTER TABLE "FeeRecord" ADD COLUMN "overrideReason" TEXT;

UPDATE "FeeRecord" f
SET "overrideReason" = o."overrideReason"
FROM "StudentFeeOverride" o
WHERE f."overrideId" = o.id
  AND f."overrideReason" IS NULL;

DROP INDEX IF EXISTS "FeeRecord_overrideId_key";
DROP INDEX IF EXISTS "StudentFeeOverride_feeRecordId_key";
ALTER TABLE "StudentFeeOverride" DROP COLUMN IF EXISTS "feeRecordId";

-- Backfill due dates for existing invoices: monthly fees fall due on the configured
-- day (clamped to the month's last day); admission/package invoices are due on the
-- day they were issued.
WITH cfg AS (
    SELECT COALESCE((SELECT "dueDay" FROM "Institute" ORDER BY "createdAt" ASC LIMIT 1), 10) AS due_day
)
UPDATE "Invoice" i
SET "dueDate" = CASE
    WHEN i."billingMonth" ~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
        MAKE_DATE(
            CAST(SUBSTRING(i."billingMonth" FROM 1 FOR 4) AS INT),
            CAST(SUBSTRING(i."billingMonth" FROM 6 FOR 2) AS INT),
            LEAST(
                cfg.due_day,
                EXTRACT(DAY FROM (
                    DATE_TRUNC('month', MAKE_DATE(
                        CAST(SUBSTRING(i."billingMonth" FROM 1 FOR 4) AS INT),
                        CAST(SUBSTRING(i."billingMonth" FROM 6 FOR 2) AS INT),
                        1
                    )) + INTERVAL '1 month - 1 day'
                ))::int
            )
        )
    ELSE i."createdAt"
END
FROM cfg
WHERE i."dueDate" IS NULL;

-- C4: carry any legacy tuition structures that still have no category assignment
-- into the canonical FeeAssignment table. Existing assignments are never overwritten.
INSERT INTO "FeeAssignment" (id, "categoryId", "classId", amount, "isActive", "createdAt", "updatedAt")
SELECT DISTINCT ON (fs."classId")
       MD5('migrate-tuition-' || cat.id || '-' || fs."classId"),
       cat.id,
       fs."classId",
       fs.amount,
       TRUE,
       NOW(),
       NOW()
FROM "FeeStructure" fs
JOIN "FeeCategory" cat ON cat.code = 'TUITION'
WHERE fs."classId" IS NOT NULL
  AND fs."isActive" = TRUE
  AND NOT EXISTS (
      SELECT 1 FROM "FeeAssignment" fa
      WHERE fa."categoryId" = cat.id AND fa."classId" = fs."classId"
  )
ORDER BY fs."classId", fs."createdAt" ASC;
