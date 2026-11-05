-- H3: make the academic-year label canonical ('YYYY-YY') everywhere it is used
-- for numbering/reporting, then align the sequence counters with existing rows.

-- Invoices: derive the year from billingMonth when present, otherwise createdAt.
UPDATE "Invoice"
SET "academicYear" = CASE
    WHEN "billingMonth" ~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
        CASE
            WHEN CAST(SUBSTRING("billingMonth" FROM 6 FOR 2) AS INT) >= 7
                THEN SUBSTRING("billingMonth" FROM 1 FOR 4) || '-' ||
                     LPAD(((CAST(SUBSTRING("billingMonth" FROM 1 FOR 4) AS INT) + 1) % 100)::text, 2, '0')
            ELSE
                (CAST(SUBSTRING("billingMonth" FROM 1 FOR 4) AS INT) - 1)::text || '-' ||
                LPAD((CAST(SUBSTRING("billingMonth" FROM 1 FOR 4) AS INT) % 100)::text, 2, '0')
        END
    WHEN EXTRACT(MONTH FROM "createdAt") >= 7 THEN
        EXTRACT(YEAR FROM "createdAt")::int::text || '-' ||
        LPAD(((EXTRACT(YEAR FROM "createdAt")::int + 1) % 100)::text, 2, '0')
    ELSE
        (EXTRACT(YEAR FROM "createdAt")::int - 1)::text || '-' ||
        LPAD((EXTRACT(YEAR FROM "createdAt")::int % 100)::text, 2, '0')
END;

-- Exams historically stored a full end year ('2026-2027'); collapse it to 'YYYY-YY'.
UPDATE "Exam"
SET "academicYear" =
    SUBSTRING("academicYear" FROM '^(\d{4})-\d{2,4}$') || '-' ||
    LPAD(((SUBSTRING("academicYear" FROM '^(\d{4})')::int + 1) % 100)::text, 2, '0')
WHERE "academicYear" ~ '^\d{4}-\d{2,4}$'
  AND "academicYear" !~ '^\d{4}-\d{2}$';

-- Repoint existing invoice numbers at the canonical academic year, keeping their
-- allocated ordinal so customers holding a printed invoice see the same number.
UPDATE "Invoice"
SET "invoiceNo" = 'INV-' || "academicYear" || '-' || SUBSTRING("invoiceNo" FROM '(\d{5})$')
WHERE "invoiceNo" ~ '\d{5}$'
  AND "invoiceNo" <> ('INV-' || "academicYear" || '-' || SUBSTRING("invoiceNo" FROM '(\d{5})$'));

-- Allocate numbers for invoices that never had one (legacy admission invoices).
WITH maxseq AS (
    SELECT "academicYear",
           COALESCE(MAX((SUBSTRING("invoiceNo" FROM '(\d{5})$'))::int), 0) AS maxn
    FROM "Invoice"
    WHERE "invoiceNo" IS NOT NULL
    GROUP BY "academicYear"
), numbered AS (
    SELECT i.id,
           i."academicYear",
           ROW_NUMBER() OVER (
               PARTITION BY i."academicYear"
               ORDER BY i."createdAt" ASC, i.id ASC
           ) AS rn
    FROM "Invoice" i
    WHERE i."invoiceNo" IS NULL
)
UPDATE "Invoice" i
SET "invoiceNo" = 'INV-' || n."academicYear" || '-' ||
                  LPAD((COALESCE(m.maxn, 0) + n.rn)::text, 5, '0')
FROM numbered n
LEFT JOIN maxseq m ON m."academicYear" = n."academicYear"
WHERE i.id = n.id;

-- Payments: same canonical prefix, based on the invoice they settle.
UPDATE "Payment" p
SET "paymentNo" = 'REC-' || i."academicYear" || '-' || SUBSTRING(p."paymentNo" FROM '(\d{5})$')
FROM "Invoice" i
WHERE p."invoiceId" = i.id
  AND p."paymentNo" ~ '\d{5}$'
  AND p."paymentNo" <> ('REC-' || i."academicYear" || '-' || SUBSTRING(p."paymentNo" FROM '(\d{5})$'));

WITH maxseq AS (
    SELECT i."academicYear",
           COALESCE(MAX((SUBSTRING(p."paymentNo" FROM '(\d{5})$'))::int), 0) AS maxn
    FROM "Payment" p
    JOIN "Invoice" i ON i.id = p."invoiceId"
    WHERE p."paymentNo" IS NOT NULL
    GROUP BY i."academicYear"
), numbered AS (
    SELECT p.id,
           i."academicYear",
           ROW_NUMBER() OVER (
               PARTITION BY i."academicYear"
               ORDER BY p."createdAt" ASC, p.id ASC
           ) AS rn
    FROM "Payment" p
    JOIN "Invoice" i ON i.id = p."invoiceId"
    WHERE p."paymentNo" IS NULL
)
UPDATE "Payment" p
SET "paymentNo" = 'REC-' || n."academicYear" || '-' ||
                  LPAD((COALESCE(m.maxn, 0) + n.rn)::text, 5, '0')
FROM numbered n
LEFT JOIN maxseq m ON m."academicYear" = n."academicYear"
WHERE p.id = n.id;

-- Merge legacy two-digit sequence scopes into their canonical four-digit form.
DELETE FROM "NumberSequence" old
WHERE old.scope ~ '^(invoice|payment)-\d{2}-\d{2}$'
  AND EXISTS (
      SELECT 1 FROM "NumberSequence" canonical
      WHERE canonical.scope = REGEXP_REPLACE(old.scope, '^(invoice|payment)-(\d{2})-(\d{2})$', '\1-20\2-\3')
  );

UPDATE "NumberSequence"
SET scope = REGEXP_REPLACE(scope, '^(invoice|payment)-(\d{2})-(\d{2})$', '\1-20\2-\3')
WHERE scope ~ '^(invoice|payment)-\d{2}-\d{2}$';

-- Make the next allocation continue after the highest number already issued.
INSERT INTO "NumberSequence" (id, scope, last, "updatedAt")
SELECT MD5('invoice-' || "academicYear"), 'invoice-' || "academicYear",
       MAX((SUBSTRING("invoiceNo" FROM '(\d{5})$'))::int), NOW()
FROM "Invoice"
WHERE "invoiceNo" IS NOT NULL
GROUP BY "academicYear"
ON CONFLICT (scope) DO UPDATE
SET last = GREATEST("NumberSequence".last, EXCLUDED.last),
    "updatedAt" = NOW();

INSERT INTO "NumberSequence" (id, scope, last, "updatedAt")
SELECT MD5('payment-' || i."academicYear"), 'payment-' || i."academicYear",
       MAX((SUBSTRING(p."paymentNo" FROM '(\d{5})$'))::int), NOW()
FROM "Payment" p
JOIN "Invoice" i ON i.id = p."invoiceId"
WHERE p."paymentNo" IS NOT NULL
GROUP BY i."academicYear"
ON CONFLICT (scope) DO UPDATE
SET last = GREATEST("NumberSequence".last, EXCLUDED.last),
    "updatedAt" = NOW();

-- C3: the admission handler used to book income when the bill was created, before
-- any money arrived. Payments then booked a second income row. Reverse the
-- payment-less duplicates so reports stop counting admissions twice.
UPDATE "LedgerEntry"
SET "reversedAt" = NOW()
WHERE type = 'income'
  AND category = 'admission_fee'
  AND "paymentId" IS NULL
  AND "feeRecordId" IS NOT NULL
  AND "reversedAt" IS NULL;

-- Invoice/payment numbers must be unique now that every row is backfilled.
CREATE UNIQUE INDEX "Invoice_invoiceNo_key" ON "Invoice"("invoiceNo");
CREATE UNIQUE INDEX "Payment_paymentNo_key" ON "Payment"("paymentNo");
