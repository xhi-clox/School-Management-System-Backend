-- Reversal marker for ledger rows.
--
-- Voiding a payment previously appended a compensating 'expense' row while leaving
-- the original 'income' row intact, so a voided payment was counted as income AND
-- as an expense: income/expense/profit all moved by twice the voided amount.
--
-- Instead, a void now stamps the original row with reversedAt. The row is kept for
-- audit but is excluded from every total via the ACTIVE_LEDGER filter
-- ({ reversedAt: null }), which nets a void out to zero exactly once.
ALTER TABLE "LedgerEntry" ADD COLUMN "reversedAt" TIMESTAMP(3);

-- Supports the ACTIVE_LEDGER filter and reversal lookups by payment.
CREATE INDEX "LedgerEntry_reversedAt_idx" ON "LedgerEntry"("reversedAt");
