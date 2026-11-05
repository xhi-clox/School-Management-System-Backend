-- Add an explicit waiver flag. Before this, a NULL overrideAmount implicitly
-- waived the whole fee, which made a discount-only override charge nothing.
ALTER TABLE "StudentFeeOverride"
ADD COLUMN "isWaiver" BOOLEAN NOT NULL DEFAULT false;

-- Existing rows with neither an amount nor a discount were the old implicit
-- waiver form; preserve their intent. Rows with a discount and no amount become
-- ordinary discount overrides (isWaiver stays false).
UPDATE "StudentFeeOverride"
SET "isWaiver" = true
WHERE "overrideAmount" IS NULL
  AND "overrideDiscount" IS NULL;
