-- Link every category FeeRecord to exactly one Invoice.
--
-- Payment.invoiceId is required, so without an Invoice a generated or manually
-- added FeeRecord could never be collected through the normal payment flow and
-- was invisible on the Student Fees page. One Invoice per FeeRecord keeps
-- collection, receipts, void/refund and status derivation on the existing
-- invoice path instead of duplicating it.

-- Safety: the bridge has never been unique, so collapse any accidental duplicates
-- onto the lowest id before adding the constraint. No-op on clean data.
DELETE FROM "Invoice" a
USING "Invoice" b
WHERE a."migrationFeeRecordId" IS NOT NULL
  AND b."migrationFeeRecordId" IS NOT NULL
  AND a."migrationFeeRecordId" = b."migrationFeeRecordId"
  AND a.id > b.id;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_migrationFeeRecordId_key" ON "Invoice"("migrationFeeRecordId");

-- AddForeignKey
-- ON DELETE CASCADE so deleting a FeeRecord cannot leave an orphan, still
-- collectable Invoice behind. Payment history is protected at the application
-- layer: deleteFeeRecord refuses while any payment exists on the record or its
-- bridged Invoice, so this cascade never destroys a payment row.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_migrationFeeRecordId_fkey" FOREIGN KEY ("migrationFeeRecordId") REFERENCES "FeeRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
