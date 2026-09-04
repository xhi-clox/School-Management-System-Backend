-- Add gradingSnapshot (frozen grading config) to ExamSchedule
ALTER TABLE "ExamSchedule" ADD COLUMN     "gradingSnapshot" JSONB;

-- Fix grading bands to use canonical exclusive-max format (clean whole numbers).
-- Boundary logic: min inclusive, max exclusive except the final 100% band (inclusive).
-- All templates use universal percentage ranges:
--   A+ = 80-100%, A = 70-80%, A- = 60-70%, B = 50-60%, C = 40-50%, D = 33-40%, F = 0-33%

UPDATE "GradingSystem" SET "minPercent" = 0,  "maxPercent" = 33  WHERE "grade" = 'F'  AND "examTypeId" IN ('cmtkejwth0046tisoy2uuo4ff', 'cmtkeob5a0000oc3dm3txwlj9');
UPDATE "GradingSystem" SET "minPercent" = 33, "maxPercent" = 40  WHERE "grade" = 'D'  AND "examTypeId" IN ('cmtkejwth0046tisoy2uuo4ff', 'cmtkeob5a0000oc3dm3txwlj9');
UPDATE "GradingSystem" SET "minPercent" = 40, "maxPercent" = 50  WHERE "grade" = 'C'  AND "examTypeId" IN ('cmtkejwth0046tisoy2uuo4ff', 'cmtkeob5a0000oc3dm3txwlj9');
UPDATE "GradingSystem" SET "minPercent" = 50, "maxPercent" = 60  WHERE "grade" = 'B'  AND "examTypeId" IN ('cmtkejwth0046tisoy2uuo4ff', 'cmtkeob5a0000oc3dm3txwlj9');
UPDATE "GradingSystem" SET "minPercent" = 60, "maxPercent" = 70  WHERE "grade" = 'A-' AND "examTypeId" IN ('cmtkejwth0046tisoy2uuo4ff', 'cmtkeob5a0000oc3dm3txwlj9');
UPDATE "GradingSystem" SET "minPercent" = 70, "maxPercent" = 80  WHERE "grade" = 'A'  AND "examTypeId" IN ('cmtkejwth0046tisoy2uuo4ff', 'cmtkeob5a0000oc3dm3txwlj9');
UPDATE "GradingSystem" SET "minPercent" = 80, "maxPercent" = 100 WHERE "grade" = 'A+' AND "examTypeId" IN ('cmtkejwth0046tisoy2uuo4ff', 'cmtkeob5a0000oc3dm3txwlj9');
