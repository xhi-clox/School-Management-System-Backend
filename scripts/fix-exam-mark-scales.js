const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function valueFor(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const apply = process.argv.includes('--apply');
const examRef = valueFor('--exam-id', null);
const examName = valueFor('--exam-name', 'SECOND SEMESTER EXAMINATION 2026');
const subjectNames = valueFor('--subjects', 'Bangla,English,Mathematics')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const oldFull = Number(valueFor('--old-full', '50'));
const newFull = Number(valueFor('--new-full', '100'));

function gradeForMarks(bands, total, isAbsent) {
  if (isAbsent) return { grade: 'ABSENT', gp: 0 };
  const sorted = [...bands].sort((a, b) => a.minPercent - b.minPercent);
  let matched = sorted[0];
  for (const band of sorted) {
    if (Number(band.minPercent) <= total + 0.0001) matched = band;
  }
  return { grade: matched?.grade || 'F', gp: matched?.gp ?? 0 };
}

function scaleMark(value, factor) {
  return Math.max(0, Math.round((Number(value) || 0) * factor));
}

(async () => {
  if (!Number.isFinite(oldFull) || !Number.isFinite(newFull) || oldFull <= 0 || newFull <= 0) {
    throw new Error('--old-full and --new-full must be positive numbers');
  }

  const exam = examRef
    ? await prisma.exam.findUnique({ where: { id: examRef }, include: { type: true } })
    : await prisma.exam.findFirst({ where: { name: examName }, include: { type: true } });
  if (!exam) throw new Error('Exam not found');
  if (exam.status === 'Published') {
    throw new Error('Exam is Published. Unpublish it before fixing mark scales.');
  }
  if (!String(exam.type?.name || '').includes(String(newFull))) {
    throw new Error(`Exam type "${exam.type?.name}" does not match --new-full ${newFull}`);
  }

  const bands = await prisma.gradingSystem.findMany({
    where: { examTypeId: exam.typeId },
    orderBy: { minPercent: 'asc' },
    select: { grade: true, minPercent: true, maxPercent: true, gp: true, status: true, totalFull: true },
  });
  if (!bands.length) throw new Error(`No grading bands found for exam type ${exam.typeId}`);
  const templateTotalFull = bands.find((b) => Number(b.totalFull) > 0)?.totalFull || newFull;
  const snapshot = {
    templateId: exam.typeId,
    templateName: exam.type?.name || 'Grading Template',
    snapshotDate: new Date().toISOString(),
    totalFull: templateTotalFull,
    bands,
  };

  const [schedules, results, students, classes] = await Promise.all([
    prisma.examSchedule.findMany({ where: { examId: exam.id }, include: { subject: true } }),
    prisma.result.findMany({ where: { examId: exam.id }, include: { student: true } }),
    prisma.student.findMany({ select: { id: true, class: true, section: true } }),
    prisma.schoolClass.findMany({ select: { id: true, name: true, section: true } }),
  ]);

  const classIdByNameSection = new Map(classes.map((c) => [c.name + '|' + c.section, c.id]));
  const classNameById = new Map(classes.map((c) => [c.id, c.name + ' ' + c.section]));
  const scheduleByClassSubject = new Map(schedules.map((s) => [(s.classId || '') + '|' + s.subjectId, s]));
  const targetSchedules = schedules.filter((s) => {
    const name = String(s.subject?.name || '').toLowerCase();
    return subjectNames.includes(name) && s.fullMarks === oldFull;
  });
  const targetIds = new Set(targetSchedules.map((s) => s.id));

  const affectedResults = results.filter((result) => {
    const student = result.student;
    const classId = classIdByNameSection.get(student.class + '|' + student.section) || '';
    const schedule = scheduleByClassSubject.get(classId + '|' + result.subjectId)
      || scheduleByClassSubject.get('|' + result.subjectId);
    return schedule && targetIds.has(schedule.id);
  });

  const scheduleChanges = targetSchedules.map((schedule) => {
    const factor = newFull / oldFull;
    const mcqFull = scaleMark(schedule.mcqFullMarks, factor);
    const practicalFull = scaleMark(schedule.practicalFullMarks, factor);
    const scaledWritten = scaleMark(schedule.writtenFullMarks, factor);
    const writtenFull = scaledWritten || (mcqFull || practicalFull ? 0 : newFull);
    const totalPass = Math.round(newFull * 0.33);
    return {
      id: schedule.id,
      class: classNameById.get(schedule.classId || '') || 'GLOBAL',
      subject: schedule.subject?.name,
      oldFull: schedule.fullMarks,
      newFull,
      writtenFull: writtenFull + (newFull - (writtenFull + mcqFull + practicalFull)),
      mcqFull,
      practicalFull,
      totalPass,
      writtenPass: Math.round(writtenFull * 0.33),
      mcqPass: Math.round(mcqFull * 0.33),
      practicalPass: Math.round(practicalFull * 0.33),
    };
  });

  const gradeChanges = affectedResults.map((result) => {
    const next = gradeForMarks(bands, result.totalMarks, result.isAbsent);
    return {
      id: result.id,
      student: result.student.name,
      class: result.student.class + ' ' + result.student.section,
      subjectId: result.subjectId,
      marks: result.totalMarks,
      from: result.grade + '/' + result.gp,
      to: next.grade + '/' + next.gp,
    };
  });

  console.log('Exam:', exam.name, `(${exam.id})`, 'Status:', exam.status);
  console.log('Target schedules:', scheduleChanges.length);
  console.log('Affected results:', gradeChanges.length);
  console.log('Schedules:', scheduleChanges);
  console.log('Grade changes:', gradeChanges.slice(0, 20));
  if (gradeChanges.length > 20) console.log(`... and ${gradeChanges.length - 20} more grade changes`);

  if (!apply) {
    console.log('Dry run. Re-run with --apply to write these changes.');
    return;
  }

  const highestByClassSubject = new Map();
  for (const result of affectedResults) {
    const classId = classIdByNameSection.get(result.student.class + '|' + result.student.section) || '';
    const key = classId + '|' + result.subjectId;
    if (!highestByClassSubject.has(key)) {
      highestByClassSubject.set(key, { classId, subjectId: result.subjectId, highest: 0, studentIds: new Set() });
    }
    const entry = highestByClassSubject.get(key);
    entry.highest = Math.max(entry.highest, Number(result.totalMarks) || 0);
    entry.studentIds.add(result.studentId);
  }

  const resultById = new Map(affectedResults.map((r) => [r.id, r]));

  await prisma.$transaction(async (tx) => {
    for (const schedule of scheduleChanges) {
      await tx.examSchedule.update({
        where: { id: schedule.id },
        data: {
          fullMarks: newFull,
          passMarks: schedule.totalPass,
          writtenFullMarks: schedule.writtenFull,
          mcqFullMarks: schedule.mcqFull,
          practicalFullMarks: schedule.practicalFull,
          writtenPassMarks: schedule.writtenPass,
          mcqPassMarks: schedule.mcqPass,
          practicalPassMarks: schedule.practicalPass,
          gradingTypeId: exam.typeId,
          gradingSnapshot: snapshot,
        },
      });
    }

    for (const change of gradeChanges) {
      const result = resultById.get(change.id);
      const next = gradeForMarks(bands, result.totalMarks, result.isAbsent);
      await tx.result.update({
        where: { id: result.id },
        data: { grade: next.grade, gp: next.gp },
      });
    }

    for (const entry of highestByClassSubject.values()) {
      await tx.result.updateMany({
        where: {
          examId: exam.id,
          subjectId: entry.subjectId,
          studentId: { in: [...entry.studentIds] },
        },
        data: { highestMarks: entry.highest },
      });
    }
  }, { timeout: 120000, maxWait: 10000 });

  console.log('Applied successfully.');
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
