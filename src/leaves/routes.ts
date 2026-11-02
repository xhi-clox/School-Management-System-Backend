/**
 * Leave Management — REST API.
 *
 * Mounted in index.ts at `app.use('/leaves', leavesRouter)`.
 * Conventions follow src/fees/routes.ts: authMiddleware on every route,
 * explicit checkRole lists, zod validation, small helper helpers for errors.
 *
 * Permissions (adapted to the existing role architecture: Admin = User table,
 * Teacher/Student authenticate via their own tables, Parent = User with role
 * 'Parent' linked through the Parent.students relation):
 *
 * | Action            | Student | Parent | Teacher        | Admin |
 * |-------------------|---------|--------|----------------|-------|
 * | Apply             | own     | child  | scoped classes | yes   |
 * | View              | own     | child  | scoped classes | all   |
 * | Approve/Reject    | no      | no     | scoped         | yes   |
 * | Cancel approved   | request | request| scoped         | yes   |
 * | Analytics         | own     | child  | scoped         | all   |
 * | Holidays/Settings | read    | read   | read           | write |
 */
import { Request, Response } from 'express';
import express from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import {
  ACTIVE_STUDENT_STATUS,
  LEAVE_CATEGORIES,
  toDateStr,
  attendanceDayKey,
  utcMidnight,
  leaveDayCounts,
  resolveLeaveScope,
  canReviewFor,
  syncApprovedLeaveToAttendance,
  reconcileCancelledLeave,
  notifyLeaveInterestedParties,
  findLeaveConflicts,
} from './shared';
import { authMiddleware } from '../auth';
import { checkRole } from '../checkRole';
import { isBase64Image } from '../cloudinary';

const prisma = new PrismaClient();
const router = express.Router();

function fail(res: Response, status: number, message: string, extra?: any) {
  return res.status(status).json({ error: message, ...(extra ? { ...extra } : {}) });
}

const auth = (req: Request, res: Response, next: any) => authMiddleware(req, res, next);

function actorOf(user: any) {
  return {
    actorName: user?.name || user?.email || null,
    actorId: user?.id || null,
    actorRole: user?.role || null,
  };
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const DAY_KEY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const attachmentsSchema = z
  .array(
    z
      .string()
      .refine(
        (v) => isBase64Image(v) || /^https?:\/\/\S+$/.test(v),
        'Attachments must be image uploads or http(s) links'
      )
  )
  .max(3, 'At most 3 attachments per application');
// Base64 images are converted to Cloudinary URLs by the global body middleware
// (index.ts) — the same pipeline used for student avatars.

const createLeaveSchema = z
  .object({
    studentId: z.string().min(1).optional(),
    leaveType: z.enum(['FULL_DAY', 'HALF_DAY']),
    halfDaySession: z.enum(['FIRST', 'SECOND']).optional(),
    startDate: DAY_KEY,
    endDate: DAY_KEY,
    category: z.string().refine((c) => (LEAVE_CATEGORIES as readonly string[]).includes(c), 'Unknown leave category'),
    reason: z.string().trim().min(3, 'Reason is required').max(2000),
    contactInfo: z.string().trim().max(200).optional(),
    remarks: z.string().trim().max(1000).optional(),
    attachments: attachmentsSchema.optional(),
  })
  .refine((d) => d.endDate >= d.startDate, { message: 'End date cannot precede the start date' })
  .refine((d) => d.leaveType !== 'HALF_DAY' || d.halfDaySession != null, {
    message: 'Half-day leave requires a session (FIRST or SECOND)',
  })
  .refine((d) => d.leaveType === 'HALF_DAY' || !d.halfDaySession, {
    message: 'halfDaySession only applies to half-day leave',
  });

const approveSchema = z.object({
  remarks: z.string().trim().max(1000).optional(),
  allowConflicts: z.boolean().optional(),
});

const rejectSchema = z.object({
  reason: z.string().trim().min(3, 'A rejection reason is required').max(1000),
});

const cancelSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

const updateLeaveSchema = z
  .object({
    leaveType: z.enum(['FULL_DAY', 'HALF_DAY']).optional(),
    halfDaySession: z.enum(['FIRST', 'SECOND']).optional(),
    startDate: DAY_KEY.optional(),
    endDate: DAY_KEY.optional(),
    category: z.string().refine((c) => (LEAVE_CATEGORIES as readonly string[]).includes(c), 'Unknown leave category').optional(),
    reason: z.string().trim().min(3).max(2000).optional(),
    contactInfo: z.string().trim().max(200).optional(),
    remarks: z.string().trim().max(1000).optional(),
    attachments: attachmentsSchema.optional(),
  });

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const leaveIncludeStudent = {
  student: {
    select: {
      id: true, name: true, class: true, section: true, roll: true,
      admissionNo: true, avatar: true, status: true, email: true,
    },
  },
};

function serializeLeave(l: any) {
  return {
    id: l.id,
    studentId: l.studentId,
    student: l.student ? {
      id: l.student.id,
      name: l.student.name,
      class: l.student.class,
      section: l.student.section,
      roll: l.student.roll,
      admissionNo: l.student.admissionNo,
      avatar: l.student.avatar,
      status: l.student.status,
    } : null,
    applicantId: l.applicantId,
    applicantName: l.applicantName,
    applicantRole: l.applicantRole,
    leaveType: l.leaveType,
    halfDaySession: l.halfDaySession,
    startDate: toDateStr(l.startDate),
    endDate: toDateStr(l.endDate),
    category: l.category,
    reason: l.reason,
    contactInfo: l.contactInfo,
    remarks: l.remarks,
    attachments: l.attachments || [],
    status: l.status,
    calendarDays: l.calendarDays,
    workingDays: l.workingDays,
    approvedById: l.approvedById,
    approvedByName: l.approvedByName,
    approvedAt: l.approvedAt ? l.approvedAt.toISOString() : null,
    reviewRemarks: l.reviewRemarks,
    rejectedById: l.rejectedById,
    rejectedByName: l.rejectedByName,
    rejectedAt: l.rejectedAt ? l.rejectedAt.toISOString() : null,
    rejectionReason: l.rejectionReason,
    cancelledAt: l.cancelledAt ? l.cancelledAt.toISOString() : null,
    cancelledByName: l.cancelledByName,
    cancelRequested: l.cancelRequested,
    cancelRequestNote: l.cancelRequestNote,
    attendanceSyncedAt: l.attendanceSyncedAt ? l.attendanceSyncedAt.toISOString() : null,
    syncSummary: l.syncSummary,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Restrict a leave where-clause to the actor's scope (multi-tenant isolation substitute). */
async function scopedLeaveWhere(user: any) {
  const scope = await resolveLeaveScope(user);
  if (scope.kind === 'all') return { where: {} as any, scope };
  if (scope.kind === 'classIds') {
    if (scope.classIds.length === 0) return null;
    const classes = await prisma.schoolClass.findMany({
      where: { id: { in: scope.classIds } },
      select: { name: true, section: true },
    });
    const pairs = classes.map((c) => ({ class: c.name, section: c.section }));
    return { where: { student: { OR: pairs } } as any, scope };
  }
  // studentIds
  if (scope.studentIds.length === 0) return null;
  return { where: { studentId: { in: scope.studentIds } } as any, scope };
}

// ---------------------------------------------------------------------------
// Apply for leave
// ---------------------------------------------------------------------------

router.post('/', auth, checkRole(['Admin', 'Teacher', 'Student', 'Parent']), async (req: Request, res: Response) => {
  const parsed = createLeaveSchema.safeParse(req.body);
  if (!parsed.success) {
    return fail(res, 400, 'Invalid leave application', { details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const user = (req as any).user;

  try {
    // 1. Resolve the student + applicant authorization.
    let studentId = data.studentId;
    let applicantRole = user.role;

    if (user.role === 'Student') {
      if (studentId && studentId !== user.id) {
        return fail(res, 403, 'Students may only apply for their own leave');
      }
      studentId = user.id;
    } else if (!studentId) {
      return fail(res, 400, 'studentId is required');
    }

    const student = await prisma.student.findUnique({ where: { id: String(studentId) } });
    if (!student) return fail(res, 404, 'Student not found');

    if (user.role === 'Parent') {
      const pUser = await prisma.user.findUnique({
        where: { id: user.id },
        include: { parent: { include: { students: { select: { id: true } } } } },
      });
      const childIds = (pUser?.parent?.students || []).map((s: any) => s.id);
      if (!childIds.includes(student.id)) {
        return fail(res, 403, 'Parents may only apply for their linked children');
      }
    } else if (user.role === 'Teacher') {
      const ok = await canReviewFor(user, student.id);
      if (!ok) return fail(res, 403, 'You can only apply for students in your assigned classes');
    }

    if (student.status !== ACTIVE_STUDENT_STATUS) {
      return fail(res, 409, 'Leave applications are only accepted for students currently on roll');
    }

    // 2. Validate the range against the institution calendar.
    const startKey = attendanceDayKey(data.startDate);
    const endKey = attendanceDayKey(data.endDate);
    if (utcMidnight(endKey) < utcMidnight(startKey)) {
      return fail(res, 400, 'End date cannot precede the start date');
    }
    const counts = await leaveDayCounts(startKey, endKey);
    if (counts.workingDays === 0) {
      return fail(res, 422, 'The selected range contains no school working days (only holidays / weekly closures). Nothing to apply for.', {
        calendarDays: counts.calendarDays,
        weeklyOffDates: counts.weeklyOffDates,
        holidayDates: counts.holidayDates,
      });
    }

    // 3. Duplicate / overlapping application protection.
    const conflicts = await findLeaveConflicts(student.id, startKey, endKey);
    if (conflicts.overlappingApplications.some((o) => o.status === 'PENDING')) {
      return fail(res, 409, 'A pending application already covers overlapping dates for this student. Review or modify it instead of submitting a duplicate.', { conflicts });
    }
    if (conflicts.overlappingApplications.some((o) => o.status === 'APPROVED')) {
      return fail(res, 409, 'Approved leave already exists for overlapping dates. Cancellation of the existing leave is required first.', { conflicts });
    }

    // 4. Create (with an audit trail entry).
    const days = counts.calendarDays;
    const apexDaysToWarn = counts;
    const leave = await prisma.$transaction(async (tx) => {
      const l = await tx.leave.create({
        data: {
          studentId: student.id,
          applicantId: user.id,
          applicantName: user.name || user.email || null,
          applicantRole,
          leaveType: data.leaveType,
          halfDaySession: data.halfDaySession ?? null,
          startDate: utcMidnight(startKey),
          endDate: utcMidnight(endKey),
          category: data.category,
          reason: data.reason,
          contactInfo: data.contactInfo ?? null,
          remarks: data.remarks ?? null,
          attachments: data.attachments ?? [],
          status: 'PENDING',
          calendarDays: apexDaysToWarn.calendarDays,
          workingDays: apexDaysToWarn.workingDays,
        },
      });
      await tx.leaveActivity.create({
        data: {
          leaveId: l.id,
          action: 'SUBMITTED',
          ...actorOf(user),
          details: {
            studentName: student.name,
            category: data.category,
            leaveType: data.leaveType,
            startDate: startKey,
            endDate: endKey,
            calendarDays: apexDaysToWarn.calendarDays,
            workingDays: apexDaysToWarn.workingDays,
            attachmentCount: (data.attachments || []).length,
          },
        },
      });
      return l;
    });

    await notifyLeaveInterestedParties(
      { id: leave.id, applicantId: user.id, applicantRole, applicantName: user.name },
      'New leave application',
      `${student.name} applied for ${data.category.toLowerCase()} leave (${startKey} → ${endKey}, ${apexDaysToWarn.workingDays} working days).`,
    );

    const filled = await prisma.leave.findUnique({ where: { id: leave.id }, include: leaveIncludeStudent });
    res.status(201).json(serializeLeave(filled));
  } catch (error: any) {
    console.error('Create leave error:', error);
    fail(res, 500, 'Failed to submit leave application', { details: error.message });
  }
});

// ---------------------------------------------------------------------------
// List applications (role-scoped, filterable)
// ---------------------------------------------------------------------------

router.get('/', auth, checkRole(['Admin', 'Teacher', 'Student', 'Parent']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const scoped = await scopedLeaveWhere(user);
    if (scoped === null) {
      return res.json({ items: [], total: 0, scope: (await resolveLeaveScope(user)).kind });
    }

    const q: any = req.query;
    const filters: any[] = [];
    if (q.status) {
      const statuses = String(q.status).split(',').filter(Boolean);
      filters.push({ status: { in: statuses } });
    }
    if (q.leaveType) filters.push({ leaveType: String(q.leaveType) });
    if (q.className) filters.push({ student: { class: String(q.className) } });
    if (q.section) filters.push({ student: { section: String(q.section) } });
    if (q.studentId) filters.push({ studentId: String(q.studentId) });
    if (q.q) {
      const term = String(q.q).trim();
      if (term) {
        filters.push({
          OR: [
            { reason: { contains: term, mode: 'insensitive' } },
            { student: { name: { contains: term, mode: 'insensitive' } } },
            { student: { admissionNo: { contains: term, mode: 'insensitive' } } },
          ],
        });
      }
    }
    if (q.submittedFrom || q.submittedTo) {
      filters.push({
        createdAt: {
          ...(q.submittedFrom ? { gte: new Date(String(q.submittedFrom)) } : {}),
          ...(q.submittedTo ? { lte: new Date(String(q.submittedTo)) } : {}),
        },
      });
    }
    if (q.leaveDateFrom) filters.push({ endDate: { gte: utcMidnight(String(q.leaveDateFrom)) } });
    if (q.leaveDateTo) filters.push({ startDate: { lte: utcMidnight(String(q.leaveDateTo)) } });

    const where = { ...scoped.where, AND: filters };
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));

    const [items, total] = await Promise.all([
      prisma.leave.findMany({
        where,
        include: leaveIncludeStudent,
        orderBy: q.sort === 'startDate' ? { startDate: 'desc' } : { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.leave.count({ where }),
    ]);

    res.json({ items: items.map(serializeLeave), total, page, limit });
  } catch (error: any) {
    console.error('List leaves error:', error);
    fail(res, 500, 'Failed to load leave applications');
  }
});

// ---------------------------------------------------------------------------
// Stats + upcoming
// ---------------------------------------------------------------------------

router.get('/stats', auth, checkRole(['Admin', 'Teacher', 'Student', 'Parent']), async (req: Request, res: Response) => {
  try {
    const scoped = await scopedLeaveWhere((req as any).user);
    if (scoped === null) return res.json({ role: (req as any).user.role, total: 0 });

    const today = utcMidnight(todayKey());
    const base = scoped.where;

    const [total, pending, approved, rejected, cancelled] = await Promise.all([
      prisma.leave.count({ where: base }),
      prisma.leave.count({ where: { ...base, status: 'PENDING' } }),
      prisma.leave.count({ where: { ...base, status: 'APPROVED' } }),
      prisma.leave.count({ where: { ...base, status: 'REJECTED' } }),
      prisma.leave.count({ where: { ...base, status: 'CANCELLED' } }),
    ]);

    const currentlyOnLeave = await prisma.leave.findMany({
      where: {
        ...base, status: 'APPROVED',
        startDate: { lte: today },
        endDate: { gte: today },
      },
      select: { id: true },
    });

    const upcoming = await prisma.leave.findMany({
      where: { ...base, status: 'APPROVED', startDate: { gt: today } },
      select: { id: true },
    });

    // Applications needing attention: pending for > 48h or starting within 3 days.
    const attentionCutoff = new Date(today);
    attentionCutoff.setDate(attentionCutoff.getDate() - 2);
    const startSoon = new Date(today);
    startSoon.setDate(startSoon.getDate() + 3);
    const requiringAttention = await prisma.leave.count({
      where: {
        ...base,
        status: 'PENDING',
        AND: [
          { OR: [{ createdAt: { lte: attentionCutoff } }, { startDate: { lte: startSoon } }] },
        ],
      },
    });

    const cancelRequests = await prisma.leave.count({
      where: { ...base, cancelRequested: true, status: 'APPROVED' },
    });

    res.json({
      role: (req as any).user.role,
      total,
      pending,
      approved,
      rejected,
      cancelled,
      onLeaveToday: currentlyOnLeave.length,
      upcomingLeaves: upcoming.length,
      requiringAttention,
      cancelRequests,
    });
  } catch (error: any) {
    console.error('Leave stats error:', error);
    fail(res, 500, 'Failed to load leave statistics');
  }
});

router.get('/upcoming', auth, checkRole(['Admin', 'Teacher', 'Parent', 'Student']), async (req: Request, res: Response) => {
  try {
    const scoped = await scopedLeaveWhere((req as any).user);
    if (scoped === null) return res.json([]);
    const today = utcMidnight(todayKey());
    // Approved leaves starting after today, or already started but not ended.
    const items = await prisma.leave.findMany({
      where: {
        ...scoped.where,
        status: 'APPROVED',
        endDate: { gte: today },
      },
      include: leaveIncludeStudent,
      orderBy: [{ startDate: 'asc' }],
      take: 100,
    });
    res.json(items.map(serializeLeave));
  } catch (error: any) {
    fail(res, 500, 'Failed to load upcoming leaves');
  }
});

// ---------------------------------------------------------------------------
// Analytics (actual vs approved attendance percentages)
// ---------------------------------------------------------------------------

router.get('/analytics', auth, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  try {
    const scoped = await scopedLeaveWhere((req as any).user);
    if (scoped === null) return res.json([]);

    const from = req.query.from ? attendanceDayKey(String(req.query.from)) : (() => { const d = new Date(); d.setUTCDate(1); return localDay(d); })();
    const to = req.query.to ? attendanceDayKey(String(req.query.to)) : todayKey();

    // Determine class rows: admin -> all classes; teacher -> allowed classes.
    const classes = await prisma.schoolClass.findMany({
      where: scoped.scope.kind === 'classIds'
        ? { id: { in: (scoped.scope as any).classIds } }
        : undefined,
      orderBy: [{ name: 'asc' }, { section: 'asc' }],
    });

    const studentWhere = {
      status: ACTIVE_STUDENT_STATUS,
      OR: classes.map((c) => ({ class: c.name, section: c.section })),
    };
    const students = await prisma.student.findMany({
      where: studentWhere,
      select: { id: true, name: true, roll: true, class: true, section: true },
    });

    const rows = await prisma.attendance.findMany({
      where: {
        studentId: { in: students.map((s) => s.id) },
        date: { gte: utcMidnight(from), lte: utcMidnight(to) },
      },
      select: { studentId: true, date: true, status: true, leaveId: true },
    });

    // Group per student.
    const byStudent = new Map<string, { present: number; late: number; absent: number; leave: number; marked: number }>();
    const stat = { present: 0, late: 0, absent: 0, leave: 0, marked: 0 };
    for (const r of rows) {
      const s = r.status || '';
      const norm = s.toLowerCase();
      const b = byStudent.get(r.studentId) || { present: 0, late: 0, absent: 0, leave: 0, marked: 0 };
      if (norm === 'present') b.present++;
      else if (norm === 'late') b.late++;
      else if (norm === 'absent') b.absent++;
      else if (norm === 'leave') b.leave++;
      b.marked++;
      byStudent.set(r.studentId, b);
    }

    // Working days in the range are shared for every student (register is school-wide).
    const counts = await leaveDayCounts(from, to);
    const wdays = Math.max(counts.workingDays, 1);

    const perClass = new Map<string, { className: string; section: string; students: any[] }>();
    for (const s of students) {
      const key = `${s.class}-${s.section}`;
      if (!perClass.has(key)) perClass.set(key, { className: s.class, section: s.section, students: [] });
      const b = byStudent.get(s.id) || { ...undefined_placeholder_stat() };
      const actual = ((b.present + b.late) / wdays) * 100;
      const approved = ((b.present + b.late + b.leave) / wdays) * 100;
      perClass.get(key)!.students.push({
        studentId: s.id,
        name: s.name,
        roll: s.roll,
        present: b.present,
        late: b.late,
        absent: b.absent,
        leave: b.leave,
        unmarked: Math.max(0, wdays - b.marked),
        actualAttendancePct: Math.min(100, Math.round(actual * 10) / 10),
        approvedAttendancePct: Math.min(100, Math.round(approved * 10) / 10),
      });
    }

    const out = Array.from(perClass.values())
      .map((entry) => ({
        className: entry.className,
        section: entry.section,
        workingDays: wdays,
        range: { from, to },
        avgActual: round1(avg(entry.students.map((s) => s.actualAttendancePct))),
        avgApproved: round1(avg(entry.students.map((s) => s.approvedAttendancePct))),
        students: entry.students.sort((a, b) => a.roll - b.roll),
      }));

    res.json(out);
  } catch (error: any) {
    console.error('Leave analytics error:', error);
    fail(res, 500, 'Failed to compute leave analytics');
  }
});

function undefined_placeholder_stat() {
  return { present: 0, late: 0, absent: 0, leave: 0, marked: 0 };
}

function avg(nums: number[]) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Settings: weekly working-day configuration
// ---------------------------------------------------------------------------

router.get('/settings', auth, async (req: Request, res: Response) => {
  try {
    const institute = await prisma.institute.findFirst({ select: { weeklyOffDays: true } });
    res.json({ weeklyOffDays: institute?.weeklyOffDays ?? [] });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load leave settings' });
  }
});

router.put('/settings', auth, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    weeklyOffDays: z.array(z.enum(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid weekly off configuration', { details: parsed.error.flatten() });
  try {
    const institute = await prisma.institute.findFirst({ where: {} });
    if (!institute) return fail(res, 404, 'Institute profile not found');
    const updated = await prisma.institute.update({
      where: { id: institute.id },
      data: { weeklyOffDays: parsed.data.weeklyOffDays },
      select: { weeklyOffDays: true },
    });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update leave settings' });
  }
});

// ---------------------------------------------------------------------------
// Holidays (official + institutional)
// ---------------------------------------------------------------------------

router.get('/holidays', auth, async (req: Request, res: Response) => {
  try {
    const year = req.query.year ? Number(req.query.year) : null;
    const rows = await prisma.holiday.findMany({
      where: year
        ? { startDate: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } }
        : undefined,
      orderBy: { startDate: 'asc' },
    });
    res.json(rows.map((h) => ({
      id: h.id,
      name: h.name,
      description: h.description,
      startDate: toDateStr(h.startDate),
      endDate: h.endDate ? toDateStr(h.endDate) : null,
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load holidays' });
  }
});

const holidaySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).optional(),
    startDate: DAY_KEY,
    endDate: DAY_KEY.nullable().optional(),
  })
  .refine((d) => !d.endDate || d.endDate >= d.startDate, { message: 'Holiday end date cannot precede its start date' });

router.post('/holidays', auth, checkRole(['Admin']), async (req: Request, res: Response) => {
  const parsed = holidaySchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid holiday payload', { details: parsed.error.flatten() });
  try {
    const created = await prisma.holiday.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        startDate: utcMidnight(parsed.data.startDate),
        endDate: parsed.data.endDate ? utcMidnight(parsed.data.endDate) : null,
      },
    });
    res.status(201).json(created);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to create holiday' });
  }
});

router.put('/holidays/:id', auth, checkRole(['Admin']), async (req: Request, res: Response) => {
  const parsed = holidaySchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid holiday payload', { details: parsed.error.flatten() });
  try {
    const updated = await prisma.holiday.update({
      where: { id: req.params.id },
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        startDate: utcMidnight(parsed.data.startDate),
        endDate: parsed.data.endDate ? utcMidnight(parsed.data.endDate) : null,
      },
    });
    res.json(updated);
  } catch (error: any) {
    fail(res, error?.code === 'P2025' ? 404 : 500, error?.code === 'P2025' ? 'Holiday not found' : error.message);
  }
});

function isMissingHolidayError(error: any) {
  return error?.code === 'P2025';
}

router.delete('/holidays/:id', auth, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    await prisma.holiday.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error: any) {
    fail(res, error?.code === 'P2025' ? 404 : 500, error?.code === 'P2025' ? 'Holiday not found' : error.message);
  }
});

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

router.get('/:id', auth, checkRole(['Admin', 'Teacher', 'Student', 'Parent']), async (req: Request, res: Response) => {
  try {
    const scoped = await scopedLeaveWhere((req as any).user);
    const base = scoped ? scoped.where : { id: 'never' };
    const leave = await prisma.leave.findFirst({
      where: { AND: [base, { id: req.params.id }] },
      include: leaveIncludeStudent,
    });
    if (!leave) return fail(res, 404, 'Leave application not found');

    const startKey = attendanceDayKey(toDateStr(leave.startDate));
    const endKey = attendanceDayKey(toDateStr(leave.endDate));

    const [activities, conflicts, attendanceRows, holidays] = await Promise.all([
      prisma.leaveActivity.findMany({ where: { leaveId: leave.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      findLeaveConflicts(leave.studentId, startKey, endKey, leave.id),
      prisma.attendance.findMany({
        where: { studentId: leave.studentId, date: { gte: utcMidnight(startKey), lte: utcMidnight(endKey) } },
        orderBy: { date: 'asc' },
        select: { date: true, status: true, leaveId: true },
      }),
      prisma.holiday.findMany({
        where: { startDate: { lte: utcMidnight(endKey) }, OR: [{ endDate: { gte: utcMidnight(startKey) } }, { AND: [{ endDate: null }, { startDate: { gte: utcMidnight(startKey) } }] }] },
        orderBy: { startDate: 'asc' },
      }),
    ]);

    const serialized = serializeLeave(leave);
    res.json({
      ...serialized,
      activities: activities.map((a) => ({
        id: a.id,
        action: a.action,
        actorId: a.actorId,
        actorName: a.actorName,
        actorRole: a.actorRole,
        details: a.details,
        createdAt: a.createdAt.toISOString(),
      })),
      conflicts,
      attendanceRecords: attendanceRows.map((a) => ({
        date: toDateStr(a.date),
        status: a.status,
        linkedToThisLeave: a.leaveId === leave.id,
        linkedToOtherLeave: !!a.leaveId && a.leaveId !== leave.id,
      })),
      holidays: holidays.map((h) => ({
        id: h.id, name: h.name, startDate: toDateStr(h.startDate), endDate: h.endDate ? toDateStr(h.endDate) : null,
      })),
      dayBreakdown: await breakdownFor(startKey, endKey),
    });
  } catch (error: any) {
    console.error('Leave detail error:', error);
    fail(res, 500, 'Failed to load leave application');
  }
});

async function breakdownFor(startKey: string, endKey: string) {
  const counts = await leaveDayCounts(startKey, endKey);
  return {
    calendarDays: counts.calendarDays,
    workingDays: counts.workingDays,
    weeklyOffDates: counts.weeklyOffDates,
    holidayDates: counts.holidayDates,
    workingDates: counts.workingDates,
  };
}

// ---------------------------------------------------------------------------
// Approve / Reject / Cancel / Request-cancel / Request-info / Modify / Sync
// ---------------------------------------------------------------------------

router.post('/:id/approve', auth, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const parsed = approveSchema.safeParse(req.body || {});
  if (!parsed.success) return fail(res, 400, 'Invalid approval payload', { details: parsed.error.flatten() });
  const user = (req as any).user;
  try {
    const leave = await prisma.leave.findUnique({ where: { id: req.params.id }, include: { student: true } });
    if (!leave) return fail(res, 404, 'Leave application not found');
    if (!(await requireReviewerFor(user, res, leave.studentId))) return;
    if (leave.status !== 'PENDING') {
      return fail(res, 409, `Only PENDING applications can be approved (current status: ${leave.status})`);
    }

    // Conflict gate — Present rows and overlapping approved leaves are flagged,
    // never silently overwritten. Reviewer has to pass allowConflicts=true.
    if (!parsed.data.allowConflicts) {
      const conflicts = await findLeaveConflicts(leave.studentId, attendanceDayKey(toDateStr(leave.startDate)), attendanceDayKey(toDateStr(leave.endDate)), leave.id);
      const overlappingApproved = conflicts.overlappingApplications.filter((o) => o.status === 'APPROVED');
      if (conflicts.presentDays.length > 0 || overlappingApproved.length > 0) {
        return fail(res, 409, 'Conflicts detected — review the application details before approving.', {
          conflicts: {
            presentDays: conflicts.presentDays,
            overlappingApproved,
          },
        });
      }
    }

    const startKey = attendanceDayKey(toDateStr(leave.startDate));
    const endKey = attendanceDayKey(toDateStr(leave.endDate));
    const counts = await leaveDayCounts(startKey, endKey);

    // Approval + sync are two steps (sync may be idempotently re-run by
    // POST /leaves/:id/sync), but the approval mutation itself is atomic.
    const updated = await prisma.$transaction(async (tx) => {
      const l = await tx.leave.update({
        where: { id: leave.id },
        data: {
          status: 'APPROVED',
          approvedById: user.id,
          approvedByName: actorOf(user).actorName,
          approvedAt: new Date(),
          reviewRemarks: parsed.data.remarks ?? null,
          cancelRequested: false,
          calendarDays: counts.calendarDays,
          workingDays: counts.workingDays,
        },
        include: leaveIncludeStudent,
      });
      await tx.leaveActivity.create({
        data: {
          leaveId: l.id,
          action: 'APPROVED',
          ...actorOf(user),
          details: {
            remarks: parsed.data.remarks ?? null,
            workingDays: counts.workingDays,
            calendarDays: counts.calendarDays,
          },
        },
      });
      return l;
    });

    // Sync attendance idempotently (full approval flow).
    const sync = await syncApprovedLeaveToAttendance(leave.id);
    await prisma.leaveActivity.create({
      data: {
        leaveId: leave.id,
        action: 'ATTENDANCE_SYNCED',
        ...actorOf(user),
        details: sync as any,
      },
    });

    await notifyLeaveInterestedParties(
      { id: leave.id, applicantId: leave.applicantId, applicantRole: leave.applicantRole },
      'Leave approved',
      `${leave.student.name}'s ${leave.category.toLowerCase()} leave (${startKey} → ${endKey}) was approved by ${actorOf(user).actorName}. Attendance updated for ${sync.created.length + sync.overwritten.length + sync.adopted.length} day(s).`,
    );

    res.json({ leave: serializeLeave(updated), sync });
  } catch (error: any) {
    console.error('Approve leave error:', error);
    fail(res, 500, 'Failed to approve leave application');
  }
});

router.post('/:id/reject', auth, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const parsed = rejectSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return fail(res, 400, 'A rejection reason is required', { details: parsed.error.flatten() });
  }
  const user = (req as any).user;
  try {
    const leave = await prisma.leave.findUnique({ where: { id: req.params.id }, include: { student: true } });
    if (!leave) return fail(res, 404, 'Leave application not found');
    if (!(await requireReviewerFor(user, res, leave.studentId))) return;
    if (leave.status !== 'PENDING') {
      return fail(res, 409, `Only PENDING applications can be rejected (current status: ${leave.status})`);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const l = await tx.leave.update({
        where: { id: leave.id },
        data: {
          status: 'REJECTED',
          rejectedById: user.id,
          rejectedByName: actorOf(user).actorName,
          rejectedAt: new Date(),
          rejectionReason: parsed.data.reason,
        },
        include: leaveIncludeStudent,
      });
      await tx.leaveActivity.create({
        data: {
          leaveId: l.id,
          action: 'REJECTED',
          ...actorOf(user),
          details: { reason: parsed.data.reason },
        },
      });
      return l;
    });

    await notifyLeaveInterestedParties(
      { id: leave.id, applicantId: leave.applicantId, applicantRole: leave.applicantRole },
      'Leave rejected',
      `${leave.student.name}'s ${leave.category.toLowerCase()} leave (${toDateStr(leave.startDate)} → ${toDateStr(leave.endDate)}) was rejected: ${parsed.data.reason}`,
    );

    res.json({ leave: serializeLeave(updated) });
  } catch (error: any) {
    console.error('Reject leave error:', error);
    fail(res, 500, 'Failed to reject leave application');
  }
});

/**
 * Cancellation:
 *  - PENDING: applicant or an authorized reviewer cancels outright (no attendance impact).
 *  - APPROVED: Admin/authorized Teacher only -> CANCELLED + attendance reconciliation.
 */
router.post('/:id/cancel', auth, checkRole(['Admin', 'Teacher', 'Student', 'Parent']), async (req: Request, res: Response) => {
  const parsed = cancelSchema.safeParse(req.body || {});
  const user = (req as any).user;
  try {
    const leave = await prisma.leave.findUnique({ where: { id: req.params.id }, include: { student: true } });
    if (!leave) return fail(res, 404, 'Leave application not found');

    const isApplicant = leave.applicantId === user.id;
    const reviewer = await requireReviewerFor(user, res, leave.studentId, { quiet: true });

    if (leave.status === 'PENDING') {
      if (!isApplicant && !reviewer) {
        return fail(res, 403, 'Only the applicant or an authorized reviewer can cancel a pending application');
      }
      const updated = await prisma.$transaction(async (tx) => {
        const l = await tx.leave.update({
          where: { id: leave.id },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByName: actorOf(user).actorName, cancelRequested: false },
          include: leaveIncludeStudent,
        });
        await tx.leaveActivity.create({
          data: { leaveId: l.id, action: 'CANCELLED_PENDING', ...actorOf(user), details: { note: parsed.data?.note ?? null } },
        });
        return l;
      });
      return res.json({ leave: serializeLeave(updated), reconciliation: null });
    }

    if (leave.status === 'APPROVED') {
      if (!isApplicant && !reviewer) {
        return fail(res, 403, 'Only an authorized reviewer (Admin/scope Teacher) can cancel an approved leave');
      }
      if (isApplicant && !reviewer && leave.attendanceSyncedAt) {
        // Applicants go through the request path so reconciliation is deliberate.
        return fail(res, 409, 'Approved leave already synced to attendance. Use "Request cancellation" instead.');
      }

      const updated = await prisma.$transaction(async (tx) => {
        const l = await tx.leave.update({
          where: { id: leave.id },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByName: actorOf(user).actorName, cancelRequested: false },
          include: leaveIncludeStudent,
        });
        await tx.leaveActivity.create({
          data: { leaveId: l.id, action: 'CANCELLED', ...actorOf(user), details: { note: parsed.data?.note ?? null } },
        });
        return l;
      });

      const reconciliation = await reconcileCancelledLeave(leave.id);
      await prisma.leaveActivity.create({
        data: { leaveId: leave.id, action: 'ATTENDANCE_RECONCILED', ...actorOf(user), details: reconciliation as any },
      });

      await notifyLeaveInterestedParties(
        { id: leave.id, applicantId: leave.applicantId, applicantRole: leave.applicantRole },
        'Leave cancelled',
        `${leave.student.name}'s approved leave (${toDateStr(leave.startDate)} → ${toDateStr(leave.endDate)}) was cancelled${parsed.data?.note ? `: ${parsed.data.note}` : ''}. Attendance reconciled.`,
      );

      return res.json({ leave: serializeLeave(updated), reconciliation });
    }

    return fail(res, 409, `Only PENDING or APPROVED applications can be cancelled (current status: ${leave.status})`);
  } catch (error: any) {
    console.error('Cancel leave error:', error);
    fail(res, 500, 'Failed to cancel leave application');
  }
});

async function requireReviewerFor(
  user: any,
  res: Response,
  studentId: string,
  opts?: { quiet?: boolean }
): Promise<boolean> {
  const ok = await canReviewFor(user, studentId);
  if (!ok && !opts?.quiet) {
    fail(res, 403, 'You are not authorized to review leave for this student');
  }
  return ok;
}

router.post('/:id/request-cancel', auth, checkRole(['Admin', 'Teacher', 'Student', 'Parent']), async (req: Request, res: Response) => {
  const parsed = cancelSchema.safeParse(req.body || {});
  const user = (req as any).user;
  try {
    const leave = await prisma.leave.findUnique({ where: { id: req.params.id }, include: { student: true } });
    if (!leave) return fail(res, 404, 'Leave application not found');
    if (leave.applicantId !== user.id && !(await canReviewFor(user, leave.studentId))) {
      return fail(res, 403, 'Only the applicant or an authorized reviewer can request cancellation');
    }
    if (leave.status !== 'APPROVED') {
      return fail(res, 409, 'Cancellation requests apply to approved leaves. Pending applications can be cancelled directly.');
    }

    const updated = await prisma.leave.update({
      where: { id: leave.id },
      data: { cancelRequested: true, cancelRequestNote: parsed.data?.note ?? null },
      include: leaveIncludeStudent,
    });
    await prisma.leaveActivity.create({
      data: { leaveId: leave.id, action: 'CANCEL_REQUESTED', ...actorOf(user), details: { note: parsed.data?.note ?? null } },
    });
    await notifyLeaveInterestedParties(
      { id: leave.id, applicantId: leave.applicantId, applicantRole: leave.applicantRole },
      'Leave cancellation requested',
      `${user.name || 'Someone'} requested cancellation of the approved leave for ${leave.student.name}. Attendance has NOT changed yet — an authorized reviewer must cancel it.`,
    );
    res.json({ leave: serializeLeave(updated) });
  } catch (error: any) {
    fail(res, 500, 'Failed to request leave cancellation');
  }
});

router.post('/:id/request-info', auth, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({ message: z.string().trim().min(3).max(1000) });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return fail(res, 400, 'A message is required', { details: parsed.error.flatten() });
  const user = (req as any).user;
  try {
    const leave = await prisma.leave.findUnique({ where: { id: req.params.id }, include: { student: true } });
    if (!leave) return fail(res, 404, 'Leave application not found');
    if (!(await requireReviewerFor(user, res, leave.studentId))) return;
    if (leave.status !== 'PENDING') return fail(res, 409, 'Only PENDING applications can be queried for more information');

    await prisma.$transaction(async (tx) => {
      await tx.leaveActivity.create({
        data: { leaveId: leave.id, action: 'REQUEST_INFO', ...actorOf(user), details: { message: parsed.data.message } },
      });
      if (leave.applicantRole === 'Parent') {
        await tx.notification.create({
          data: { userId: leave.applicantId, title: 'More information requested', body: `Your leave application for ${leave.student.name}: ${parsed.data.message}` },
        });
      }
    });

    res.json({ ok: true });
  } catch (error: any) {
    fail(res, 500, 'Failed to notify applicant');
  }
});

// Modify an application (pending only, applicant or admin).
router.put('/:id', auth, checkRole(['Admin', 'Teacher', 'Student', 'Parent']), async (req: Request, res: Response) => {
  const parsed = updateLeaveSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Invalid modification payload', { details: parsed.error.flatten() });
  const user = (req as any).user;
  try {
    const leave = await prisma.leave.findUnique({ where: { id: req.params.id } });
    if (!leave) return fail(res, 404, 'Leave application not found');
    const isApplicant = leave.applicantId === user.id;
    const canAdmin = await canReviewFor(user, leave.studentId);
    if (!isApplicant && !canAdmin) {
      return fail(res, 403, 'Only the applicant or an authorized reviewer can modify');
    }
    if (leave.status !== 'PENDING') {
      return fail(res, 409, 'Only PENDING applications can be modified. Cancel and re-apply for approved leave so the attendance history stays correct.');
    }

    const startDate = parsed.data.startDate ?? toDateStr(leave.startDate);
    const endDate = parsed.data.endDate ?? toDateStr(leave.endDate);
    if (utcMidnight(endDate) < utcMidnight(startDate)) {
      return fail(res, 400, 'End date cannot precede the start date');
    }
    const leaveType = parsed.data.leaveType ?? leave.leaveType;
    const halfDaySession = leaveType === 'HALF_DAY' ? (parsed.data.halfDaySession ?? leave.halfDaySession) : null;
    if (leaveType === 'HALF_DAY' && !halfDaySession) {
      return fail(res, 400, 'Half-day leave requires a session (FIRST or SECOND)');
    }

    const counts = await leaveDayCounts(startDate, endDate);
    if (counts.workingDays === 0) {
      return fail(res, 422, 'The modified range contains no school working days.');
    }

    const conflicts = await findLeaveConflicts(leave.studentId, startDate, endDate, leave.id);
    if (conflicts.overlappingApplications.some((o) => o.status !== 'REJECTED' && o.status !== 'CANCELLED')) {
      return fail(res, 409, 'The modified dates overlap existing pending or approved leave.', { conflicts });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const l = await tx.leave.update({
        where: { id: leave.id },
        data: {
          leaveType,
          halfDaySession,
          startDate: utcMidnight(startDate),
          endDate: utcMidnight(endDate),
          category: parsed.data.category ?? leave.category,
          reason: parsed.data.reason ?? leave.reason,
          contactInfo: parsed.data.contactInfo ?? leave.contactInfo,
          remarks: parsed.data.remarks ?? leave.remarks,
          attachments: parsed.data.attachments ?? leave.attachments,
          calendarDays: counts.calendarDays,
          workingDays: counts.workingDays,
        },
        include: leaveIncludeStudent,
      });
      await tx.leaveActivity.create({
        data: {
          leaveId: l.id,
          action: 'MODIFIED',
          ...actorOf(user),
          details: {
            before: { startDate: toDateStr(leave.startDate), endDate: toDateStr(leave.endDate), leaveType: leave.leaveType },
            after: { startDate, endDate, leaveType },
          },
        },
      });
      return l;
    });

    await notifyLeaveInterestedParties(
      { id: leave.id, applicantId: leave.applicantId, applicantRole: leave.applicantRole },
      'Leave application modified',
      `Leave application for ${updated.student?.name || 'a student'} was modified (${startDate} → ${endDate}).`,
    );

    res.json({ leave: serializeLeave(updated) });
  } catch (error: any) {
    console.error('Modify leave error:', error);
    fail(res, 500, 'Failed to modify leave application');
  }
});

// Re-run attendance synchronization (repairs drift, idempotent).
router.post('/:id/sync', auth, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const leave = await prisma.leave.findUnique({ where: { id: req.params.id } });
    if (!leave) return fail(res, 404, 'Leave application not found');
    if (leave.status !== 'APPROVED') return fail(res, 409, 'Approved leave only — sync runs after approval');
    const user = (req as any).user;
    const sync = await syncApprovedLeaveToAttendance(leave.id);
    await prisma.leaveActivity.create({
      data: { leaveId: leave.id, action: 'ATTENDANCE_SYNCED', ...actorOf(user), details: sync as any, actorRole: 'Admin' },
    });
    res.json({ sync });
  } catch (error: any) {
    fail(res, 500, 'Failed to synchronize attendance', { details: error.message });
  }
});

// ---------------------------------------------------------------------------
// Settings + Holidays (registered earlier in this router file)
// ---------------------------------------------------------------------------

export default router;
