-- DropIndex
DROP INDEX "Attendance_date_idx";

-- DropIndex
DROP INDEX "Exam_academicYear_idx";

-- AlterTable
ALTER TABLE "Exam" ALTER COLUMN "typeId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "GradingSystem" ALTER COLUMN "examTypeId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Subject" ADD COLUMN     "creditHours" DOUBLE PRECISION NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "Attendance_date_status_idx" ON "Attendance"("date", "status");

-- CreateIndex
CREATE INDEX "Exam_academicYear_status_idx" ON "Exam"("academicYear", "status");

-- CreateIndex
CREATE INDEX "Result_examId_studentId_idx" ON "Result"("examId", "studentId");
