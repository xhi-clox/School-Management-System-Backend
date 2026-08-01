-- AlterTable
ALTER TABLE "ExamSchedule" ADD COLUMN     "roomNo" TEXT;

-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN     "designation" TEXT NOT NULL DEFAULT 'Teacher',
ADD COLUMN     "joiningDate" TIMESTAMP(3),
ADD COLUMN     "salary" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "TeacherLogin" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'Teacher',
    "status" TEXT NOT NULL DEFAULT 'Active',
    "lastLogin" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherLogin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Institute" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'NexGrad Institute',
    "logo" TEXT,
    "targetLine" TEXT DEFAULT 'Excellence in Education',
    "phone" TEXT,
    "website" TEXT,
    "address" TEXT,
    "country" TEXT,
    "email" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Institute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherLogin_teacherId_key" ON "TeacherLogin"("teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherLogin_username_key" ON "TeacherLogin"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Institute_email_key" ON "Institute"("email");

-- AddForeignKey
ALTER TABLE "TeacherLogin" ADD CONSTRAINT "TeacherLogin_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
