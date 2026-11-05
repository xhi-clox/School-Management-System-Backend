-- Refunds are not voids: the money was genuinely collected and then returned.
-- Keep a distinct status and reason so receipts, reports and audits can tell the
-- two cases apart while both are excluded from active collections.
ALTER TABLE "Payment" ADD COLUMN "refundedAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "refundReason" TEXT;
