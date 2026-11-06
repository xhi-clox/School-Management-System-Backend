/*
 * Regrade a published/finished exam from stored marks.
 *
 * Why this exists:
 *   Grades are stored on each Result row at marks-entry time. If an exam was
 *   graded against the wrong full-marks scale (e.g. Mathematics scheduled as
 *   100 marks while its grading bands are on a 50-mark scale), the stored
 *   grade/gp stay wrong even after the schedule is corrected. This script
 *   recomputes stored grades from the current schedule + grading bands.
 *
 * Usage (run inside School-Management-System-Backend, with DATABASE_URL set):
 *   node scripts/regrade-exam.js --exam="Modal"                 # dry run
 *   node scripts/regrade-exam.js --exam="Modal" --subject="Math" --apply
 *   node scripts/regrade-exam.js --exam="Modal" --subject="Math" \
 *        --set-full-marks=50 --set-pass-marks=20 --apply
 *
 * Flags:
 *   --exam=<id|name substring>   (default "Modal")
 *   --subject=<id|name substring> (optional; default all subjects)
 *   --set-full-marks=<n>          normalize full marks for matched subjects
 *   --set-pass-marks=<n>          normalize pass marks for matched subjects
 *   --apply                       write changes (default: dry run)
 */
const fs = require('fs');
const path = require('path');

// Load .env (if present) without overwriting real environment variables.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  })
);
const APPLY = !!args.apply;
const EXAM_FILTER = String(args.exam || 'Modal');
const SUBJECT_FILTER = args.subject ? String(args.subject) : null;
const SET_FULL = args['set-full-marks'] != null ? Number(args['set-full-marks']) : null;
const SET_PASS = args['set-pass-marks'] != null ? Number(args['set-pass-marks']) : null;

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const round2 = (n) => Math.round(n * 100) / 100;
const passFor = (full, explicit) => {
  const max = Math.max(0, Number(full) || 0);
  const configured = Number(explicit) || 0;
  return configured > 0 && configured <= max ? configured : Math.min(max, Math.round(max * 0.33));
};

function expectedGrade({ totalMarks, written, mcq, practical, schedule, bands }) {
  const snap = schedule.gradingSnapshot ? parse(schedule.gradingSnapshot) : null;
  const useBands = snap && Array.isArray(snap.bands) && snap.bands.length ? snap.bands : bands;
  if (!useBands || !useBands.length) return null;

  const templateTotalFull = useBands.find((b) => Number(b.totalFull) > 0)?.totalFull;
  const bandMax = Math.max(...useBands.map((b) => Number(b.maxPercent) || 0));
  const refFull = (snap && Number(snap.totalFull) > 0 ? Number(snap.totalFull) : 0)
    || Number(templateTotalFull) || bandMax || Number(schedule.fullMarks) || 100;
  const fullMarks = Number(schedule.fullMarks) > 0 ? Number(schedule.fullMarks) : refFull;
  const asPctRef = bandMax > 0 && refFull > 0 ? Math.min(bandMax, refFull) : (bandMax || refFull || 100);
  const asPct = (v) => ((Number(v) || 0) / asPctRef) * 100;
  const percent = fullMarks > 0 ? (totalMarks / fullMarks) * 100 : 0;

  const wFull = Number(schedule.writtenFullMarks) || 0;
  const mFull = Number(schedule.mcqFullMarks) || 0;
  const pFull = Number(schedule.practicalFullMarks) || 0;
  const wPass = passFor(wFull, schedule.writtenPassMarks);
  const mPass = passFor(mFull, schedule.mcqPassMarks);
  const pPass = passFor(pFull, schedule.practicalPassMarks);
  const tPass = passFor(fullMarks, schedule.passMarks);

  let isFail = false;
  if (wFull > 0 && wPass > 0 && written < wPass) isFail = true;
  if (mFull > 0 && mPass > 0 && mcq < mPass) isFail = true;
  if (pFull > 0 && pPass > 0 && practical < pPass) isFail = true;
  if (totalMarks < tPass) isFail = true;

  if (isFail) {
    const f = useBands.find((b) => String(b.status).toUpperCase() === 'FAIL');
    return { grade: f ? f.grade : 'F', gp: f ? Number(f.gp) || 0 : 0, percent, fullMarks };
  }
  const sorted = [...useBands].sort((a, b) => asPct(a.minPercent) - asPct(b.minPercent));
  let matched = null;
  for (const b of sorted) if (asPct(b.minPercent) <= percent + 0.0001) matched = b;
  matched = matched || sorted.find((b) => String(b.status).toUpperCase() === 'FAIL') || sorted[0];
  return { grade: matched.grade, gp: Number(matched.gp) || 0, percent, fullMarks };
}

async function main() {
  const exams = await prisma.exam.findMany({
    where: { OR: [{ id: EXAM_FILTER }, { name: { contains: EXAM_FILTER, mode: 'insensitive' } }] },
    include: { type: true },
  });
  if (!exams.length) { console.log(`No exam matching "${EXAM_FILTER}"`); return; }

  const allSubjects = await prisma.subject.findMany();
  const subjectById = new Map(allSubjects.map((s) => [s.id, s]));

  for (const exam of exams) {
    console.log(`\n=== ${exam.name} (${exam.id}) status=${exam.status} type=${exam.type && exam.type.name} ===`);
    const schedules = await prisma.examSchedule.findMany({ where: { examId: exam.id }, include: { subject: true } });
    const liveBands = await prisma.gradingSystem.findMany({ where: { examTypeId: exam.typeId } });

    const matchesSubject = (s) => {
      if (!SUBJECT_FILTER) return true;
      const name = (s.subject && s.subject.name) || subjectById.get(s.subjectId)?.name || '';
      return s.subjectId === SUBJECT_FILTER || name.toLowerCase().includes(SUBJECT_FILTER.toLowerCase());
    };
    const targetSchedules = schedules.filter(matchesSubject);

    const pendingUpdates = new Map();
    if (SET_FULL != null || SET_PASS != null) {
      for (const s of targetSchedules) {
        const oldFull = Number(s.fullMarks) || 0;
        const newFull = SET_FULL != null ? SET_FULL : oldFull;
        const scale = oldFull > 0 ? newFull / oldFull : 1;
        const data = {};
        if (SET_FULL != null) {
          data.fullMarks = newFull;
          const wFull = Number(s.writtenFullMarks) || 0;
          const mFull = Number(s.mcqFullMarks) || 0;
          const pFull = Number(s.practicalFullMarks) || 0;
          if (wFull + mFull + pFull === oldFull && oldFull > 0) {
            data.writtenFullMarks = Math.round(wFull * scale);
            data.mcqFullMarks = Math.round(mFull * scale);
            data.practicalFullMarks = Math.max(0, newFull - data.writtenFullMarks - data.mcqFullMarks);
          } else if (wFull === oldFull) {
            data.writtenFullMarks = newFull;
          }
          if (Number(s.writtenPassMarks) > 0) data.writtenPassMarks = Math.round(Number(s.writtenPassMarks) * scale);
          if (Number(s.mcqPassMarks) > 0) data.mcqPassMarks = Math.round(Number(s.mcqPassMarks) * scale);
          if (Number(s.practicalPassMarks) > 0) data.practicalPassMarks = Math.round(Number(s.practicalPassMarks) * scale);
        }
        const newPass = SET_PASS != null ? SET_PASS : (Number(s.passMarks) > 0 && oldFull > 0 ? Math.round(Number(s.passMarks) * scale) : null);
        if (newPass != null) data.passMarks = newPass;

        console.log(`  schedule ${s.subject?.name || s.subjectId} class=${s.classId || 'global'}: full ${oldFull} -> ${newFull}, pass ${s.passMarks} -> ${newPass}`);
        pendingUpdates.set(s.id, data);
        if (APPLY) await prisma.examSchedule.update({ where: { id: s.id }, data });
      }
    }

    // Simulate (and, when applying, use) the normalized schedule config so the
    // regrade output below reflects the corrected full/pass marks.
    const freshSchedules = schedules.map((s) => (pendingUpdates.has(s.id) ? { ...s, ...pendingUpdates.get(s.id) } : s));
    const results = await prisma.result.findMany({ where: { examId: exam.id }, include: { student: true } });

    let changed = 0, checked = 0;
    for (const r of results) {
      const st = r.student;
      const schedule = freshSchedules.find((s) => s.subjectId === r.subjectId && s.class && s.class.name === st.class && s.class.section === st.section)
        || freshSchedules.find((s) => s.subjectId === r.subjectId && !s.class)
        || freshSchedules.find((s) => s.subjectId === r.subjectId);
      if (!schedule) continue;
      if (!matchesSubject(schedule)) continue;
      if (r.isAbsent || String(r.grade).toUpperCase() === 'ABSENT') continue;

      const bands = liveBands.filter((g) => g.examTypeId === (schedule.gradingTypeId || exam.typeId));
      const exp = expectedGrade({
        totalMarks: Number(r.totalMarks) || 0,
        written: Number(r.written) || 0,
        mcq: Number(r.mcq) || 0,
        practical: Number(r.practical) || 0,
        schedule,
        bands: bands.length ? bands : liveBands,
      });
      if (!exp) continue;
      checked++;
      if (String(exp.grade) !== String(r.grade) || round2(Number(exp.gp) || 0) !== round2(Number(r.gp) || 0)) {
        changed++;
        console.log(`  ${st.name} ${st.class}-${st.section} ${schedule.subject?.name || r.subjectId}: total=${r.totalMarks}/${exp.fullMarks} (${exp.percent.toFixed(1)}%) ${r.grade}/${r.gp} -> ${exp.grade}/${exp.gp}`);
        if (APPLY) await prisma.result.update({ where: { id: r.id }, data: { grade: exp.grade, gp: exp.gp } });
      }
    }
    console.log(`  ${APPLY ? 'APPLIED' : 'DRY RUN'}: checked ${checked}, ${changed} change(s).`);
  }
}

main()
  .catch((e) => { console.error('ERROR:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
