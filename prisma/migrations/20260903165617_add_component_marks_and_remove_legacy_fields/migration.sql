/*
  Warnings:

  - You are about to drop the column `ct` on the `Result` table. All the data in the column will be lost.
  - You are about to drop the column `cwhw` on the `Result` table. All the data in the column will be lost.
  - You are about to drop the column `dgc` on the `Result` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "GradingSystem" DROP CONSTRAINT "GradingSystem_examTypeId_fkey";

-- AlterTable
ALTER TABLE "ExamPresetSubject" ADD COLUMN     "mcqFullMarks" INTEGER,
ADD COLUMN     "mcqPassMarks" INTEGER,
ADD COLUMN     "practicalFullMarks" INTEGER,
ADD COLUMN     "practicalPassMarks" INTEGER,
ADD COLUMN     "writtenFullMarks" INTEGER,
ADD COLUMN     "writtenPassMarks" INTEGER;

-- AlterTable
ALTER TABLE "ExamSchedule" ADD COLUMN     "mcqFullMarks" INTEGER DEFAULT 0,
ADD COLUMN     "mcqPassMarks" INTEGER DEFAULT 0,
ADD COLUMN     "practicalFullMarks" INTEGER DEFAULT 0,
ADD COLUMN     "practicalPassMarks" INTEGER DEFAULT 0,
ADD COLUMN     "writtenFullMarks" INTEGER DEFAULT 0,
ADD COLUMN     "writtenPassMarks" INTEGER DEFAULT 0;

-- AlterTable
ALTER TABLE "GradingSystem" ADD COLUMN     "defaultPassPercent" DOUBLE PRECISION DEFAULT 40,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "name" TEXT,
ALTER COLUMN "examTypeId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Result" DROP COLUMN "ct",
DROP COLUMN "cwhw",
DROP COLUMN "dgc",
ADD COLUMN     "isAbsent" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "GradingSystem" ADD CONSTRAINT "GradingSystem_examTypeId_fkey" FOREIGN KEY ("examTypeId") REFERENCES "ExamType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
