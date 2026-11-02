-- Leave Management System: Leave applications + per-leave audit trail + official
-- holidays. Purely additive; existing rows (students, attendance) are untouched.
-- Weekly closure days are stored on Institute.weeklyOffDays (school-configurable).

CREATE TABLE "Leave" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "applicantId" TEXT NOT NULL,
  "applicantName" TEXT,
  "applicantRole" TEXT NOT NULL DEFAULT 'Admin',
  "leaveType" TEXT NOT NULL DEFAULT 'FULL_DAY',
  "halfDaySession" TEXT,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3) NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'Other',
  "reason" TEXT NOT NULL,
  "contactInfo" TEXT,
  "remarks" TEXT,
  "attachments" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "calendarDays" INTEGER NOT NULL DEFAULT 0,
  "workingDays" INTEGER NOT NULL DEFAULT 0,
  "approvedById" TEXT,
  "approvedByName" TEXT,
  "approvedAt" TIMESTAMP(3),
  "reviewRemarks" TEXT,
  "rejectedById" TEXT,
  "rejectedByName" TEXT,
  "rejectedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "cancelledByName" TEXT,
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "cancelRequestNote" TEXT,
  "attendanceSyncedAt" TIMESTAMP(3),
  "syncSummary" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Leave_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeaveActivity" (
  "id" TEXT NOT NULL,
  "leaveId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actorId" TEXT,
  "actorName" TEXT,
  "actorRole" TEXT,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp,

  CONSTRAINT "LeaveActivity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Holiday" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- Leave -> Student
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- LeaveActivity -> Leave
ALTER TABLE "LeaveActivity" ADD CONSTRAINT "LeaveActivity_leaveId_fkey"
  FOREIGN KEY ("leaveId") REFERENCES "Leave"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Leave_status_idx"        ON "Leave"("status");
CREATE INDEX "Leave_studentId_status_idx" ON "Leave"("studentId", "status");
CREATE INDEX "Leave_startDate_idx"     ON "Leave"("startDate");
CREATE INDEX "Leave_endDate_idx"       ON "Leave"("endDate");
CREATE INDEX "Leave_createdAt_idx"     ON "Leave"("createdAt");
CREATE INDEX "LeaveActivity_leaveId_createdAt_idx" ON "LeaveActivity"("leaveId", "createdAt");
CREATE INDEX "Holiday_startDate_idx"   ON "Holiday"("startDate");

-- Sync bookkeeping on the existing attendance register.
ALTER TABLE "Attendance" ADD COLUMN "leaveId" TEXT;
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_leaveId_fkey"
  FOREIGN KEY ("leaveId") REFERENCES "Leave"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Attendance_leaveId_idx" ON "Attendance"("leaveId");

-- Institution-configurable weekly closures used by the working-day calculator
-- (leave duration, attendance analytics). Existing rows receive the default.
ALTER TABLE "Institute" ADD COLUMN "weeklyOffDays" TEXT[] NOT NULL DEFAULT ARRAY['Friday','Saturday']::TEXT[];
