-- Fix Teacher schema and ensure all tables are up to date
-- This migration addresses the "Unknown argument `subject`" error

-- Ensure Teacher table has all required fields
ALTER TABLE "Teacher" 
ADD COLUMN IF NOT EXISTS "subject" TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS "employeeId" TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS "email" TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS "phone" TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS "avatar" TEXT,
ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'Active',
ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Ensure constraints
ALTER TABLE "Teacher" 
ADD CONSTRAINT IF NOT EXISTS "Teacher_employeeId_key" UNIQUE ("employeeId"),
ADD CONSTRAINT IF NOT EXISTS "Teacher_email_key" UNIQUE ("email");

-- Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS "Teacher_employeeId_idx" ON "Teacher"("employeeId");
CREATE INDEX IF NOT EXISTS "Teacher_email_idx" ON "Teacher"("email");

-- Update updatedAt trigger
CREATE OR REPLACE FUNCTION update_teacher_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW."updatedAt" = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_teacher_updated_at ON "Teacher";
CREATE TRIGGER update_teacher_updated_at
    BEFORE UPDATE ON "Teacher"
    FOR EACH ROW
    EXECUTE FUNCTION update_teacher_updated_at();
