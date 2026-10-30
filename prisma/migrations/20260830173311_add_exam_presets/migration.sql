-- AlterTable
ALTER TABLE "ExamSchedule" ADD COLUMN     "sortOrder" INTEGER;

-- CreateTable
CREATE TABLE "ExamPreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationHours" INTEGER,
    "onePerDay" BOOLEAN NOT NULL DEFAULT true,
    "gapDays" INTEGER,
    "gapAfterSubjects" JSONB NOT NULL DEFAULT '[]',
    "excludedWeekdays" JSONB NOT NULL DEFAULT '[5,6]',
    "defaultStartTime" TEXT,
    "defaultEndTime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamPresetClass" (
    "id" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "className" TEXT NOT NULL,
    "section" TEXT,

    CONSTRAINT "ExamPresetClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamPresetSubject" (
    "id" TEXT NOT NULL,
    "presetClassId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "fullMarks" INTEGER,
    "passMarks" INTEGER,

    CONSTRAINT "ExamPresetSubject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExamPresetClass_presetId_className_section_key" ON "ExamPresetClass"("presetId", "className", "section");

-- AddForeignKey
ALTER TABLE "ExamPresetClass" ADD CONSTRAINT "ExamPresetClass_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "ExamPreset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamPresetSubject" ADD CONSTRAINT "ExamPresetSubject_presetClassId_fkey" FOREIGN KEY ("presetClassId") REFERENCES "ExamPresetClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;
