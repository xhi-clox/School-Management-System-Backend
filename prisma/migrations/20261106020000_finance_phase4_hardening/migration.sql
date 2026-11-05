-- Payment idempotency: retrying the same client request must return the first
-- receipt instead of taking the money twice.
ALTER TABLE "Payment" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- Zero-value fee records are waivers, never "paid" without a payment.
UPDATE "FeeRecord"
SET status = 'waived'
WHERE amount <= 0 AND status <> 'waived';

-- Money columns must never go negative. These are the invariants the application
-- already enforces; the constraints stop a future code path from bypassing them.
ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_totalAmount_nonnegative" CHECK ("totalAmount" >= 0),
    ADD CONSTRAINT "Invoice_paidAmount_nonnegative" CHECK ("paidAmount" >= 0);

ALTER TABLE "Payment"
    ADD CONSTRAINT "Payment_amount_positive" CHECK (amount > 0);

ALTER TABLE "FeeRecord"
    ADD CONSTRAINT "FeeRecord_amount_nonnegative" CHECK (amount >= 0),
    ADD CONSTRAINT "FeeRecord_discountAmount_nonnegative" CHECK ("discountAmount" >= 0);

ALTER TABLE "LedgerEntry"
    ADD CONSTRAINT "LedgerEntry_amount_nonnegative" CHECK (amount >= 0);

ALTER TABLE "Institute"
    ADD CONSTRAINT "Institute_dueDay_range" CHECK ("dueDay" BETWEEN 1 AND 31);

ALTER TABLE "NumberSequence"
    ADD CONSTRAINT "NumberSequence_last_nonnegative" CHECK (last >= 0);
