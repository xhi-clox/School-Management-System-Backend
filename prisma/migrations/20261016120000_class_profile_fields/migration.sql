-- Optional class profile fields surfaced on the class detail page.
-- Purely additive: every column is nullable, so no existing row is touched and
-- no data can be lost. Nothing is dropped, renamed or backfilled.
ALTER TABLE "SchoolClass" ADD COLUMN "room" TEXT;
ALTER TABLE "SchoolClass" ADD COLUMN "floor" TEXT;
ALTER TABLE "SchoolClass" ADD COLUMN "shift" TEXT;
ALTER TABLE "SchoolClass" ADD COLUMN "startTime" TEXT;
ALTER TABLE "SchoolClass" ADD COLUMN "endTime" TEXT;
ALTER TABLE "SchoolClass" ADD COLUMN "weekDays" TEXT;
ALTER TABLE "SchoolClass" ADD COLUMN "session" TEXT;
ALTER TABLE "SchoolClass" ADD COLUMN "capacity" INTEGER;