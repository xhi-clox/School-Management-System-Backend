-- Optional identification codes printed on admit cards and other documents.
-- Purely additive: both columns are nullable and existing rows are untouched.
ALTER TABLE "Institute" ADD COLUMN "schoolCode" TEXT;
ALTER TABLE "Institute" ADD COLUMN "emisCode" TEXT;

-- New institutes use the school's establishment year as their default tagline.
ALTER TABLE "Institute" ALTER COLUMN "targetLine" SET DEFAULT 'ESTD: 2012';
