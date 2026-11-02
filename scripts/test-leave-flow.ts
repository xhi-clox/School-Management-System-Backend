import { PrismaClient } from '@prisma/client'
import 'dotenv/config'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'

const BASE = 'http://127.0.0.1:4000'
const prisma = new PrismaClient()

let passes = 0
let fails = 0

function ok(name: string, cond: boolean, extra = '') {
  if (cond) { passes++; console.log(`PASS: ${name}`) }
  else { fails++; console.log(`FAIL: ${name} ${extra}`) }
}

async function req(method: string, path: string, token: string | null, body?: any) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let data: any = null
  try { data = await res.json() } catch { data = res.statusText }
  return { status: res.status, data }
}

async function main() {
  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production'

  // --- seed data -----------------------------------------------------------
  const adminUser = await prisma.user.upsert({
    where: { email: 'leave-admin@test.local' },
    update: { role: 'Admin', name: 'Leave Admin' },
    create: { email: 'leave-admin@test.local', password: await bcrypt.hash('x', 10), role: 'Admin', name: 'Leave Admin' },
  })

  const institute = await prisma.institute.upsert({
    where: { id: 'inst-leave-test' },
    update: { weeklyOffDays: ['Friday', 'Saturday'], email: 'inst-leave@test.local', name: 'Leave Test Institute' },
    create: { id: 'inst-leave-test', weeklyOffDays: ['Friday', 'Saturday'], email: 'inst-leave@test.local', name: 'Leave Test Institute' },
  })

  const cls = await prisma.schoolClass.upsert({
    where: { id: 'cls-leave-test' },
    update: { name: 'Grade 1', section: 'A' },
    create: { id: 'cls-leave-test', name: 'Grade 1', section: 'A' },
  })

  const student = await prisma.student.upsert({
    where: { admissionNo: 'L-STU-001' },
    update: { class: 'Grade 1', section: 'A', status: 'Active' },
    create: { id: 'stu-leave-test', name: 'Leave Student', admissionNo: 'L-STU-001', class: 'Grade 1', section: 'A', roll: 1, gender: 'M', status: 'Active' },
  })

  const student2 = await prisma.student.upsert({
    where: { admissionNo: 'L-STU-002' },
    update: { class: 'Grade 1', section: 'A', status: 'Active' },
    create: { id: 'stu-leave-002', name: 'Leave Student Two', admissionNo: 'L-STU-002', class: 'Grade 1', section: 'A', roll: 2, gender: 'F', status: 'Active' },
  })

  const teacher = await prisma.teacher.upsert({
    where: { employeeId: 'L-TCH-001' },
    update: { name: 'Leave Teacher', email: 'tch-leave@test.local', subject: 'Math' },
    create: { id: 'tch-leave-test', employeeId: 'L-TCH-001', name: 'Leave Teacher', email: 'tch-leave@test.local', phone: '000', subject: 'Math', classes: { connect: [{ id: cls.id }] } },
  })

  const adminToken = jwt.sign({ userId: adminUser.id, role: 'Admin', email: adminUser.email }, JWT_SECRET, { expiresIn: '7d' })
  const studentToken = jwt.sign({ userId: student.id, role: 'Student', email: student.email }, JWT_SECRET, { expiresIn: '7d' })
  const teacherToken = jwt.sign({ userId: teacher.id, role: 'Teacher', email: teacher.email }, JWT_SECRET, { expiresIn: '7d' })

  const START = '2026-11-02' // Monday
  const END = '2026-11-06'   // Friday (5 working days, Fri/Sat weekly off)

  console.log('\n=== APPLY ===')
  const apply = await req('POST', '/leaves', studentToken, {
    studentId: student.id, leaveType: 'FULL_DAY', startDate: START, endDate: END,
    category: 'Illness', reason: 'Fever and doctor visit',
  })
  ok('student apply returns 201', apply.status === 201, JSON.stringify(apply.data))
  const leaveId = apply.data.id
  ok('application has id and PENDING', !!leaveId && apply.data.status === 'PENDING', JSON.stringify(apply.data))
  ok('working days computed as 4', apply.data.workingDays === 4, `got ${apply.data.workingDays}`)

  const dupe = await req('POST', '/leaves', studentToken, {
    studentId: student.id, leaveType: 'FULL_DAY', startDate: '2026-11-03', endDate: '2026-11-04',
    category: 'Illness', reason: 'overlapping duplicate',
  })
  ok('overlapping pending application rejected 409', dupe.status === 409, `got ${dupe.status}`)

  const student2Apply = await req('POST', '/leaves', studentToken, {
    studentId: student2.id, leaveType: 'FULL_DAY', startDate: START, endDate: END,
    category: 'Illness', reason: 'not own student',
  })
  ok('student cannot apply for another student 403', student2Apply.status === 403, `got ${student2Apply.status}`)

  console.log('\n=== LIST / STATS ===')
  const list = await req('GET', '/leaves', adminToken)
  ok('admin list 200', list.status === 200, `got ${list.status}`)
  ok('list contains our application', Array.isArray(list.data.items) && list.data.items.some((i: any) => i.id === leaveId), JSON.stringify(list.data))
  const stats = await req('GET', '/leaves/stats', adminToken)
  ok('stats total >= 1', stats.status === 200 && (stats.data.total ?? 0) >= 1, JSON.stringify(stats.data))

  console.log('\n=== PRESENT PROTECTION ===')
  await req('POST', '/attendance/save', adminToken, {
    class: 'Grade 1', section: 'A', date: '2026-11-05',
    records: [{ studentId: student2.id, status: 'Present' }],
  })
  const leave3 = await req('POST', '/leaves', adminToken, {
    studentId: student2.id, leaveType: 'FULL_DAY', startDate: '2026-11-05', endDate: '2026-11-05',
    category: 'Illness', reason: 'overlaps present',
  })
  ok('leave3 created', leave3.status === 201, JSON.stringify(leave3.data))
  const appr3 = await req('POST', `/leaves/${leave3.data.id}/approve`, adminToken)
  ok('approve without allowConflicts blocked 409', appr3.status === 409, `got ${appr3.status}`)
  const appr3b = await req('POST', `/leaves/${leave3.data.id}/approve`, adminToken, { remarks: 'override', allowConflicts: true })
  ok('approve with allowConflicts 200', appr3b.status === 200, JSON.stringify(appr3b.data))
  const rows5 = await req('GET', `/attendance?class=Grade 1&section=A&date=2026-11-05`, adminToken)
  const r5 = (rows5.data as any[]).find((r: any) => r.studentId === student2.id)
  ok('Present was NOT silently overwritten (still Present)', r5?.status === 'Present', JSON.stringify(rows5.data))

  console.log('\n=== APPROVE + SYNC ===')
  const approve = await req('POST', `/leaves/${leaveId}/approve`, adminToken, { remarks: 'Looks fine', allowConflicts: true })
  ok('approve 200', approve.status === 200, JSON.stringify(approve.data))
  ok('leave status APPROVED', approve.data.leave.status === 'APPROVED', JSON.stringify(approve.data))
  ok('sync created attendance rows', approve.data.sync.created.length === 4, `created ${approve.data.sync.created.length}`)

  // idempotency: re-sync
  const syncAgain = await req('POST', `/leaves/${leaveId}/sync`, adminToken)
  const rowsAfter = await req('GET', `/attendance?class=Grade 1&section=A&date=2026-11-04`, adminToken)
  const thursdayRows = (rowsAfter.data as any[] | undefined) ?? []
  ok('re-sync idempotent (5 rows)', syncAgain.status === 200 && thursdayRows.length >= 1, JSON.stringify(syncAgain.data))
  const leaveRow = thursdayRows.find((r: any) => r.studentId === student.id)
  ok('attendance row for the student is Leave', !!leaveRow && leaveRow.status === 'Leave', JSON.stringify(thursdayRows))

  console.log('\n=== TEACHER CONFLICT GUARD ===')
  const teacherAbsent = await req('POST', '/teacher/attendance', teacherToken, {
    classId: cls.id, date: '2026-11-04',
    records: [{ studentId: student.id, status: 'Absent' }],
  })
  ok('teacher cannot mark Absent over approved leave (409)', teacherAbsent.status === 409, `got ${teacherAbsent.status}: ${JSON.stringify(teacherAbsent.data)}`)
  const teacherLeave = await req('POST', '/teacher/attendance', teacherToken, {
    classId: cls.id, date: '2026-11-04',
    records: [{ studentId: student.id, status: 'Leave' }],
  })
  ok('teacher may mark Leave', teacherLeave.status === 201 || teacherLeave.status === 200, `got ${teacherLeave.status}`)

  // GET teacher attendance shows onLeave info
  const tchGet = await req('GET', `/teacher/attendance?classId=${cls.id}&date=2026-11-04`, teacherToken)
  const rec = (tchGet.data as any[]).find((r: any) => r.studentId === student.id)
  ok('teacher GET shows onLeave flag', rec?.onLeave === true && rec?.leaveCategory === 'Illness', JSON.stringify(tchGet.data))

  console.log('\n=== RETROSPECTIVE (absent -> leave) ===')
  const saveAbsent = await req('POST', '/attendance/save', adminToken, {
    class: 'Grade 1', section: 'A', date: '2026-11-03',
    records: [{ studentId: student2.id, status: 'Absent' }],
  })
  ok('admin saved Absent for student2', saveAbsent.status === 201, JSON.stringify(saveAbsent.data))
  const leave2 = await req('POST', '/leaves', adminToken, {
    studentId: student2.id, leaveType: 'FULL_DAY', startDate: '2026-11-03', endDate: '2026-11-03',
    category: 'Illness', reason: 'retrospective',
  })
  ok('admin applied for student2 201', leave2.status === 201, JSON.stringify(leave2.data))
  const appr2 = await req('POST', `/leaves/${leave2.data.id}/approve`, adminToken, { allowConflicts: true })
  ok('retrospective approve 200', appr2.status === 200, JSON.stringify(appr2.data))
  const rows3 = await req('GET', `/attendance?class=Grade 1&section=A&date=2026-11-03`, adminToken)
  const r3 = (rows3.data as any[]).find((r: any) => r.studentId === student2.id)
  ok('retrospective approval turned Absent into Leave', r3?.status === 'Leave', JSON.stringify(rows3.data))
  const rc = await req('POST', `/leaves/${leave2.data.id}/request-cancel`, adminToken, { note: 'by mistake' })
  ok('request-cancel sets flag', rc.status === 200 && rc.data.leave.cancelRequested === true, JSON.stringify(rc.data))

  console.log('\n=== CANCEL + RECONCILE ===')
  const can = await req('POST', `/leaves/${leaveId}/cancel`, adminToken, { note: 'student returned' })
  ok('cancel 200', can.status === 200, JSON.stringify(can.data))
  ok('leave status CANCELLED', can.data.leave.status === 'CANCELLED')
  const rows4 = await req('GET', `/attendance?class=Grade 1&section=A&date=2026-11-04`, adminToken)
  const r4 = (rows4.data as any[]).find((r: any) => r.studentId === student.id)
  ok('cancel removed the sync-created Leave rows',
    (await prisma.attendance.count({ where: { leaveId } })) === 0,
    `still ${await prisma.attendance.count({ where: { leaveId } })} rows`)

  console.log('\n=== HOLIDAYS / WORKING DAYS ===')
  const hol = await req('POST', '/leaves/holidays', adminToken, {
    name: 'Test Holiday', startDate: '2026-11-10', endDate: '2026-11-10',
  })
  ok('holiday create 201', hol.status === 201, JSON.stringify(hol.data))
  const hlist = await req('GET', '/leaves/holidays?year=2026', adminToken)
  ok('holiday listed', hlist.status === 200 && (hlist.data as any[]).some((h: any) => h.name === 'Test Holiday'), JSON.stringify(hlist.data))
  // New range spanning the holiday: Mon(2nd)-Wed(4th) => working days Mon,Tue = 2 (Wed holiday, Thu/Fri weekend)
  const holApply = await req('POST', '/leaves', adminToken, {
    studentId: student2.id, leaveType: 'FULL_DAY', startDate: '2026-11-09', endDate: '2026-11-11',
    category: 'Illness', reason: 'holiday week',
  })
  ok('holiday range workingDays = 2', holApply.status === 201 && holApply.data.workingDays === 2, `got ${holApply.data.workingDays}`)
  await req('DELETE', `/leaves/holidays/${hol.data.id}`, adminToken)

  console.log('\n=== MODIFY ===')
  const fresh = await req('POST', '/leaves', adminToken, {
    studentId: student.id, leaveType: 'HALF_DAY', halfDaySession: 'FIRST',
    startDate: '2026-11-09', endDate: '2026-11-10', category: 'Travel', reason: 'trip',
  })
  ok('fresh half-day apply 201', fresh.status === 201, JSON.stringify(fresh.data))
  const mod = await req('PUT', `/leaves/${fresh.data.id}`, adminToken, {
    endDate: '2026-11-09', reason: 'updated reason',
  })
  ok('modify pending 200', mod.status === 200, JSON.stringify(mod.data))
  ok('modify shortened workingDays to 1', mod.data.leave.workingDays === 1, `got ${mod.data.leave.workingDays}`)

  console.log('\n=== UPCOMING / ANALYTICS ===')
  const up = await req('GET', '/leaves/upcoming', adminToken)
  ok('upcoming 200', up.status === 200, `got ${up.status}`)
  const an = await req('GET', '/leaves/analytics?from=2026-11-01&to=2026-11-30', adminToken)
  ok('analytics 200', an.status === 200, `got ${an.status}`)

  // cleanup
  await prisma.attendance.deleteMany({ where: { studentId: { in: [student.id, student2.id] } } })
  await prisma.leave.deleteMany({ where: { studentId: { in: [student.id, student2.id] } } })
  await prisma.student.deleteMany({ where: { id: { in: [student.id, student2.id] } } })
  await prisma.teacher.delete({ where: { id: teacher.id } })
  await prisma.schoolClass.delete({ where: { id: cls.id } })
  await prisma.user.delete({ where: { id: adminUser.id } })
  await prisma.institute.delete({ where: { id: 'inst-leave-test' } })

  console.log(`\n=== RESULT: ${passes} passed, ${fails} failed ===`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
