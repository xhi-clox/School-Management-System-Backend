const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const nugNurs = await p.student.findMany({ where: { class: 'NURSERY' }, select: { id:true, name:true, admissionNo:true, roll:true } });
  console.log('NURSERY students:', nugNurs.length);
  if (nugNurs.length) {
    const ids = nugNurs.map(s => s.id);
    const results = await p.result.findMany({ where: { studentId: { in: ids } }, include: { exam: { select: { id:true, name:true } } } });
    console.log('Results for NURSERY students:', results.length);
    const byExam = {};
    for (const r of results) byExam[r.exam.id] = (byExam[r.exam.id] || { name: r.exam.name, count: 0 });
    for (const r of results) byExam[r.exam.id].count++;
    console.log('By exam:', JSON.stringify(byExam));
    const att = await p.examAttendance.findMany({ where: { studentId: { in: ids } } });
    console.log('ExamAttendance for NURSERY:', att.length);
  }
  const schedByClass = await p.examSchedule.groupBy({ by: ['classId'] });
  console.log('ExamSchedule classIds:', JSON.stringify(schedByClass));
  const allResults = await p.result.findMany({ include: { student: { select: { name:true, class:true } } } });
  const byClass = {};
  for (const r of allResults) {
    const k = r.student.class || '?';
    byClass[k] = (byClass[k] || 0) + 1;
  }
  console.log('All results by student class:', JSON.stringify(byClass, null, 1));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });