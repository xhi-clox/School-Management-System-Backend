-- CreateTable
CREATE TABLE "TeacherPermission" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "attendanceMode" TEXT NOT NULL DEFAULT 'assigned',
    "attendanceClassIds" TEXT[],
    "marksMode" TEXT NOT NULL DEFAULT 'assigned',
    "marksClassIds" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherPermission_teacherId_key" ON "TeacherPermission"("teacherId");

-- AddForeignKey
ALTER TABLE "TeacherPermission" ADD CONSTRAINT "TeacherPermission_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;