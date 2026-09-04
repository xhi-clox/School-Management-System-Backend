/**
 * Data Migration Script: Backfill Component Marks for Existing Exam Schedules
 * 
 * This script populates writtenFullMarks, mcqFullMarks, and practicalFullMarks
 * for existing ExamSchedule records based on their fullMarks value.
 * 
 * Default breakdown strategy:
 * - 100 marks → Written: 70, MCQ: 30, Practical: 0
 * - 50 marks  → Written: 50, MCQ: 0, Practical: 0
 * - Other     → Written: 100%, MCQ: 0, Practical: 0
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function backfillComponentMarks() {
  console.log('🔄 Starting component marks backfill...');

  try {
    // Fetch all exam schedules
    const schedules = await prisma.examSchedule.findMany({
      where: {
        OR: [
          { writtenFullMarks: 0 },
          { writtenFullMarks: null },
        ]
      },
      select: {
        id: true,
        fullMarks: true,
        passMarks: true,
        subject: {
          select: {
            name: true,
            type: true,
          }
        }
      }
    });

    console.log(`📊 Found ${schedules.length} schedules to backfill`);

    let updated = 0;
    let skipped = 0;

    for (const schedule of schedules) {
      const fullMarks = schedule.fullMarks || 100;
      let writtenFull = 0;
      let mcqFull = 0;
      let practicalFull = 0;
      let writtenPass = 0;
      let mcqPass = 0;
      let practicalPass = 0;

      // Determine component breakdown based on full marks and subject type
      if (fullMarks === 100) {
        // Standard 100-mark subject: 70 written + 30 MCQ
        writtenFull = 70;
        mcqFull = 30;
        practicalFull = 0;
        writtenPass = Math.round(fullMarks * 0.28); // 28% of written
        mcqPass = Math.round(fullMarks * 0.12); // 12% of MCQ
      } else if (fullMarks === 50) {
        // 50-mark subject: all written
        writtenFull = 50;
        mcqFull = 0;
        practicalFull = 0;
        writtenPass = Math.round(fullMarks * 0.4); // 40% pass
      } else if (fullMarks === 20 || fullMarks === 25 || fullMarks === 30) {
        // Small tests (CT): all written
        writtenFull = fullMarks;
        mcqFull = 0;
        practicalFull = 0;
        writtenPass = Math.round(fullMarks * 0.4); // 40% pass
      } else {
        // Any other marks: all written
        writtenFull = fullMarks;
        mcqFull = 0;
        practicalFull = 0;
        writtenPass = Math.round(fullMarks * 0.4); // 40% pass
      }

      // Update the schedule
      await prisma.examSchedule.update({
        where: { id: schedule.id },
        data: {
          writtenFullMarks: writtenFull,
          mcqFullMarks: mcqFull,
          practicalFullMarks: practicalFull,
          writtenPassMarks: writtenPass,
          mcqPassMarks: mcqPass,
          practicalPassMarks: practicalPass,
        }
      });

      updated++;
      
      if (updated % 10 === 0) {
        console.log(`✅ Updated ${updated}/${schedules.length} schedules...`);
      }
    }

    console.log(`\n✅ Backfill complete!`);
    console.log(`   Updated: ${updated}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`\n⚠️  IMPORTANT: Review the backfilled data and adjust as needed.`);
    console.log(`   Administrators should verify component marks match their intended exam structure.`);

  } catch (error) {
    console.error('❌ Error during backfill:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the backfill
backfillComponentMarks()
  .then(() => {
    console.log('🎉 Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Script failed:', error);
    process.exit(1);
  });
