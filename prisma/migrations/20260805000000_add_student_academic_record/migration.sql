-- CreateTable
CREATE TABLE "StudentAcademicRecord" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "section" TEXT,
    "roll" INTEGER,
    "status" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentAcademicRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudentAcademicRecord_studentId_idx" ON "StudentAcademicRecord"("studentId");

-- CreateIndex
CREATE INDEX "StudentAcademicRecord_academicYear_idx" ON "StudentAcademicRecord"("academicYear");

-- AddForeignKey
ALTER TABLE "StudentAcademicRecord" ADD CONSTRAINT "StudentAcademicRecord_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
