-- AlterTable
ALTER TABLE "ExamSchedule" ADD COLUMN     "gradingTypeId" TEXT;

-- AddForeignKey
ALTER TABLE "ExamSchedule" ADD CONSTRAINT "ExamSchedule_gradingTypeId_fkey" FOREIGN KEY ("gradingTypeId") REFERENCES "ExamType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
