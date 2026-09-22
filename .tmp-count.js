const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
const names = ['User','Student','Teacher','ExamType','Exam','Result','Attendance','Institute','SchoolClass','Subject','FeeParticular','Invoice','StudentFee','StudentAcademicRecord','ExamAttendance'];
(async () => {
  const out = {};
  for (const n of names) {
    try { out[n] = await p[n].count(); } catch (e) { out[n] = 'ERR'; }
  }
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });