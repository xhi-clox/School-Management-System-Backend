const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const nurs = await p.student.findMany({ where: { class: 'NURSERY' }, select: { id: true } });
  const ids = nurs.map(s => s.id);
  const before = await p.result.count({ where: { studentId: { in: ids } } });
  const del = await p.result.deleteMany({ where: { studentId: { in: ids } } });
  const after = await p.result.count({ where: { studentId: { in: ids } } });
  console.log('before=', before, 'deleted=', del.count, 'remaining=', after);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });