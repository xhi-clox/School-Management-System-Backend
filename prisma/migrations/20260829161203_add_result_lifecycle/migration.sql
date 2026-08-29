-- AlterTable
ALTER TABLE "Exam" ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "publishedBy" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'Draft',
ADD COLUMN     "weight" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Result" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'Draft',
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ResultPublish" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "rankBy" TEXT NOT NULL DEFAULT 'GPA',
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultPublish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResultValidationRun" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "health" DOUBLE PRECISION NOT NULL,
    "issues" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultValidationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResultPublish_examId_key" ON "ResultPublish"("examId");

-- AddForeignKey
ALTER TABLE "ResultPublish" ADD CONSTRAINT "ResultPublish_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResultValidationRun" ADD CONSTRAINT "ResultValidationRun_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
