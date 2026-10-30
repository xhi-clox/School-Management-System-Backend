-- New category-driven fee system (FeeCategory / FeeAssignment / FeeRecord / StudentFeeOverride).
-- Additive only: no existing table or column is dropped, so academic and finance data is preserved.

-- CreateTable
CREATE TABLE "FeeCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "isRecurring" BOOLEAN NOT NULL DEFAULT true,
    "frequency" TEXT NOT NULL DEFAULT 'monthly',
    "isGeneratable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeAssignment" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeRecord" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "billingPeriod" TEXT NOT NULL,
    "assignmentAmount" DECIMAL(65,30),
    "amount" DECIMAL(65,30) NOT NULL,
    "discountType" TEXT,
    "discountValue" DECIMAL(65,30),
    "discountAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "prorationType" TEXT,
    "proratedDays" INTEGER,
    "totalDays" INTEGER,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'due',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "assignmentId" TEXT,
    "overrideId" TEXT,

    CONSTRAINT "FeeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentFeeOverride" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "billingPeriod" TEXT,
    "overrideAmount" DECIMAL(65,30),
    "overrideDiscount" DECIMAL(65,30),
    "discountType" TEXT,
    "overrideReason" TEXT NOT NULL,
    "approvedBy" TEXT,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "feeRecordId" TEXT,

    CONSTRAINT "StudentFeeOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeeCategory_code_key" ON "FeeCategory"("code");
CREATE INDEX "FeeCategory_isActive_isGeneratable_idx" ON "FeeCategory"("isActive", "isGeneratable");

CREATE INDEX "FeeAssignment_categoryId_idx" ON "FeeAssignment"("categoryId");
CREATE INDEX "FeeAssignment_classId_idx" ON "FeeAssignment"("classId");
CREATE INDEX "FeeAssignment_isActive_idx" ON "FeeAssignment"("isActive");
CREATE UNIQUE INDEX "FeeAssignment_categoryId_classId_key" ON "FeeAssignment"("categoryId", "classId");

-- CRITICAL: the database-level guarantee that a student cannot be charged the same
-- fee category twice for the same billing period, regardless of how it was created.
CREATE UNIQUE INDEX "FeeRecord_studentId_categoryId_billingPeriod_key" ON "FeeRecord"("studentId", "categoryId", "billingPeriod");
CREATE UNIQUE INDEX "FeeRecord_overrideId_key" ON "FeeRecord"("overrideId");
CREATE INDEX "FeeRecord_studentId_idx" ON "FeeRecord"("studentId");
CREATE INDEX "FeeRecord_categoryId_idx" ON "FeeRecord"("categoryId");
CREATE INDEX "FeeRecord_billingPeriod_idx" ON "FeeRecord"("billingPeriod");
CREATE INDEX "FeeRecord_status_idx" ON "FeeRecord"("status");
CREATE INDEX "FeeRecord_source_idx" ON "FeeRecord"("source");
CREATE INDEX "FeeRecord_createdAt_idx" ON "FeeRecord"("createdAt");
-- Supports generation previews and category/class reporting.
CREATE INDEX "FeeRecord_categoryId_billingPeriod_idx" ON "FeeRecord"("categoryId", "billingPeriod");

-- Only one period-scoped override per student/category/period. Standing overrides
-- (billingPeriod IS NULL) are de-duplicated in the service layer because PostgreSQL
-- treats NULLs as distinct in composite unique indexes.
CREATE UNIQUE INDEX "StudentFeeOverride_feeRecordId_key" ON "StudentFeeOverride"("feeRecordId");
CREATE INDEX "StudentFeeOverride_studentId_idx" ON "StudentFeeOverride"("studentId");
CREATE INDEX "StudentFeeOverride_categoryId_idx" ON "StudentFeeOverride"("categoryId");
CREATE INDEX "StudentFeeOverride_validFrom_validTo_idx" ON "StudentFeeOverride"("validFrom", "validTo");
CREATE UNIQUE INDEX "StudentFeeOverride_studentId_categoryId_billingPeriod_key"
    ON "StudentFeeOverride"("studentId", "categoryId", "billingPeriod")
    WHERE "billingPeriod" IS NOT NULL;
CREATE UNIQUE INDEX "StudentFeeOverride_studentId_categoryId_standing_key"
    ON "StudentFeeOverride"("studentId", "categoryId")
    WHERE "billingPeriod" IS NULL;

-- AddColumn (nullable / defaulted only, so existing rows stay valid)
ALTER TABLE "Invoice" ADD COLUMN "migrationFeeRecordId" TEXT;
ALTER TABLE "LedgerEntry" ADD COLUMN "billingPeriod" TEXT, ADD COLUMN "feeCategoryId" TEXT, ADD COLUMN "feeRecordId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "feeRecordId" TEXT;
ALTER TABLE "Student" ADD COLUMN "admissionFeeRecordId" TEXT, ADD COLUMN "admissionStatus" TEXT NOT NULL DEFAULT 'pending';

CREATE INDEX "LedgerEntry_feeRecordId_idx" ON "LedgerEntry"("feeRecordId");
CREATE INDEX "LedgerEntry_feeCategoryId_billingPeriod_idx" ON "LedgerEntry"("feeCategoryId", "billingPeriod");
CREATE INDEX "Payment_feeRecordId_idx" ON "Payment"("feeRecordId");

-- Performance indexes from the earlier finance hardening pass that had never been
-- committed as a migration. Verified safe: no duplicate referenceInvoice values exist.
CREATE UNIQUE INDEX "LedgerEntry_referenceInvoice_key" ON "LedgerEntry"("referenceInvoice");
CREATE INDEX "LedgerEntry_createdAt_idx" ON "LedgerEntry"("createdAt");
CREATE INDEX "LedgerEntry_type_category_idx" ON "LedgerEntry"("type", "category");

CREATE INDEX "SchoolExpense_category_idx" ON "SchoolExpense"("category");
CREATE INDEX "SchoolExpense_date_idx" ON "SchoolExpense"("date");
CREATE INDEX "SchoolExpense_createdAt_idx" ON "SchoolExpense"("createdAt");

CREATE INDEX "TeacherSalary_teacherId_idx" ON "TeacherSalary"("teacherId");
CREATE INDEX "TeacherSalary_status_idx" ON "TeacherSalary"("status");
CREATE INDEX "TeacherSalary_paymentDate_idx" ON "TeacherSalary"("paymentDate");
CREATE INDEX "TeacherSalary_createdAt_idx" ON "TeacherSalary"("createdAt");

CREATE INDEX "StaffSalary_staffId_idx" ON "StaffSalary"("staffId");
CREATE INDEX "StaffSalary_status_idx" ON "StaffSalary"("status");
CREATE INDEX "StaffSalary_paymentDate_idx" ON "StaffSalary"("paymentDate");
CREATE INDEX "StaffSalary_createdAt_idx" ON "StaffSalary"("createdAt");

-- AddForeignKey
ALTER TABLE "FeeAssignment" ADD CONSTRAINT "FeeAssignment_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FeeCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeeAssignment" ADD CONSTRAINT "FeeAssignment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "SchoolClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeeRecord" ADD CONSTRAINT "FeeRecord_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeeRecord" ADD CONSTRAINT "FeeRecord_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FeeCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeeRecord" ADD CONSTRAINT "FeeRecord_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "FeeAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FeeRecord" ADD CONSTRAINT "FeeRecord_overrideId_fkey" FOREIGN KEY ("overrideId") REFERENCES "StudentFeeOverride"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StudentFeeOverride" ADD CONSTRAINT "StudentFeeOverride_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentFeeOverride" ADD CONSTRAINT "StudentFeeOverride_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FeeCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_feeRecordId_fkey" FOREIGN KEY ("feeRecordId") REFERENCES "FeeRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_feeRecordId_fkey" FOREIGN KEY ("feeRecordId") REFERENCES "FeeRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_feeCategoryId_fkey" FOREIGN KEY ("feeCategoryId") REFERENCES "FeeCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;