/**
 * Data Migration Script: Backfill Grading Snapshots for Existing Exam Schedules
 *
 * This script freezes the current grading configuration (bands) into each
 * ExamSchedule's `gradingSnapshot` JSON field. This is the non-retroactivity
 * safeguard: once a snapshot is stored, later edits to the grading template
 * (GradingSystem / ExamType bands) will NEVER change the grading used for the
 * schedules that already carry a snapshot.
 *
 * Resolution order for the template to snapshot:
 *   1. schedule.gradingTypeId (explicit per-subject override)
 *   2. schedule.exam.typeId (the exam's type)
 * If neither resolves to a template with bands, the schedule is skipped.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Band {
  grade: string;
  minPercent: number;
  maxPercent: number;
  gp: number;
  status: string;
}

async function backfillGradingSnapshots() {
  console.log('Starting grading snapshot backfill...');

  try {
    // Fetch all schedules; filter out ones that already carry a snapshot in JS
    // (a null check on a `Json?` column is awkward in Prisma's typed client).
    const allSchedules = await prisma.examSchedule.findMany({
      include: {
        exam: { select: { id: true, typeId: true, type: { select: { name: true } } } },
      },
    });
    const schedules = allSchedules.filter((s) => s.gradingSnapshot == null);

    console.log(`Found ${allSchedules.length} schedules, ${schedules.length} need snapshot.`);

    if (schedules.length === 0) {
      console.log('Nothing to backfill. All schedules already have a snapshot.');
      return;
    }

    // Collect every candidate grading template (by examTypeId) up front.
    const typeIds = new Set<string>();
    for (const s of schedules) {
      const tplId = s.gradingTypeId || s.exam.typeId;
      if (tplId) typeIds.add(tplId);
    }
    const gradingRows = await prisma.gradingSystem.findMany({
      where: { examTypeId: { in: [...typeIds] } },
      select: { examTypeId: true, grade: true, minPercent: true, maxPercent: true, gp: true, status: true, totalFull: true },
      orderBy: { minPercent: 'asc' },
    });
    const bandsByType = new Map<string, Band[]>();
    const totalFullByType = new Map<string, number>();
    for (const g of gradingRows) {
      const key = g.examTypeId;
      if (!key) continue;
      if (!bandsByType.has(key)) bandsByType.set(key, []);
      bandsByType.get(key)!.push({ grade: g.grade, minPercent: g.minPercent, maxPercent: g.maxPercent, gp: g.gp, status: g.status });
      if (g.totalFull) totalFullByType.set(key, g.totalFull);
    }
    const typeNameById = new Map<string, string>();
    for (const s of schedules) {
      const tplId = s.gradingTypeId || s.exam.typeId;
      if (tplId) {
        // exam.type.name is only correct when the template == exam type; for an
        // explicit gradingTypeId we look it up below.
        if (s.gradingTypeId && !typeNameById.has(tplId)) typeNameById.set(tplId, 'Grading Template');
        if (!s.gradingTypeId) typeNameById.set(tplId, s.exam.type?.name || 'Unknown');
      }
    }

    let updated = 0;
    let skipped = 0;

    for (const schedule of schedules) {
      const tplId = schedule.gradingTypeId || schedule.exam.typeId;
      if (!tplId) { skipped++; continue; }

      const bands = bandsByType.get(tplId);
      if (!bands || bands.length === 0) { skipped++; continue; }

      // Prefer the schedule's own fullMarks; fall back to the template's totalFull.
      const totalFull = schedule.fullMarks || totalFullByType.get(tplId) || 100;

      const snapshot = {
        templateId: tplId,
        templateName: typeNameById.get(tplId) || 'Unknown',
        snapshotDate: schedule.createdAt.toISOString(),
        totalFull,
        bands,
      };

      await prisma.examSchedule.update({
        where: { id: schedule.id },
        data: { gradingSnapshot: JSON.stringify(snapshot) as any },
      });

      updated++;
      if (updated % 25 === 0) console.log(`Progress: ${updated}/${schedules.length}...`);
    }

    console.log('Backfill complete.');
    console.log(`   Updated: ${updated}`);
    console.log(`   Skipped: ${skipped}`);

  } catch (error) {
    console.error('Error during backfill:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

backfillGradingSnapshots()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
