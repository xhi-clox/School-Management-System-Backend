-- CreateTable
CREATE TABLE "RoutineEntry" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "teacher" TEXT,
    "room" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutineEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutinePeriod" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "timeRange" TEXT NOT NULL,
    "isBreak" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutinePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoutineEntry_classId_section_idx" ON "RoutineEntry"("classId", "section");

-- CreateIndex
CREATE UNIQUE INDEX "RoutineEntry_classId_section_day_period_key" ON "RoutineEntry"("classId", "section", "day", "period");
