-- LedgerEntry.referenceInvoice was unique, so taking a second payment against the
-- same invoice (a partial payment and then the final instalment) hit a unique
-- violation and returned 500. The expense row written to reverse a voided payment
-- collided for the same reason, so voiding also failed once a payment existed.
--
-- Many ledger rows may legitimately reference one invoice, so uniqueness was simply
-- the wrong constraint. paymentId stays the per-transaction link. Every existing
-- reader of this column uses updateMany/deleteMany, which are unaffected.

DROP INDEX IF EXISTS "LedgerEntry_referenceInvoice_key";
CREATE INDEX "LedgerEntry_referenceInvoice_idx" ON "LedgerEntry"("referenceInvoice");