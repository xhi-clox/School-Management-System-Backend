const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const exams = await p.exam.findMany({ include: { type: true, results: true } });
  const examTypes = await p.examType.findMany({ select: { id:true, name:true } });
  const classes = await p.schoolClass.findMany({ select: { id:true, name:true, section:true } });
  const nursStudents = await p.student.findMany({ where: { class: { contains: 'ur' } }, select: { id:true, name:true, class:true } });
  console.log('EXAM TYPES:', JSON.stringify(examTypes));
  console.log('CLASSES:', JSON.stringify(classes));
  console.log('EXAMS:', JSON.stringify(exams.map(e => ({ id:e.id, name:e.name, type:e.type?.name, published:e.publishedAt?true:false, resultCount:e.results?.length })), null, 1));
  console.log('STUDENTS with class containing ur:', nursStudents.length);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });