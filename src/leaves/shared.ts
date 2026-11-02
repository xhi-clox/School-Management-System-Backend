/**
 * Leave Management — shared core.
 *
 * Design notes (documented decisions for this codebase):
 *
 * 1. Attendance in NexGrad is DAY-LEVEL (Attendance has a unique (studentId, date)
 *    row with a single status). There is no period-wise attendance, so the leave
 *    system supports FULL_DAY and HALF_DAY only — no fake period selection UI.
 *    Half-day leave never overwrites an existing attendance row, and never
 *    creates one: the teacher still records what happened on that day, and the
 *    leave record plus its activity trail show the half-day context.
 *
 * 2. Working days are derived from two configurable sources:
 *      - Institute.weeklyOffDays  (institution's weekly closures)
 *      - Holiday table            (official/institutional holidays)
 *    Nothing about the weekly schedule or holidays is hardcoded in logic.
 *
 * 3. Attendance.date is stored as UTC midnight of the local day key
 *    (`new Date('YYYY-MM-DD')`), the same convention as index.ts, so leave
 *    synchronization and the register pages always agree on the same day.
 *
 * 4. Sync is idempotent and conflict-aware:
 *      - no record            -> creates a 'Leave' row linked to leaveId
 *      - row linked to this leave -> no-op (safe re-runs)
 *      - 'Absent'/'Late'      -> overwritten to 'Leave', prior value recorded
 *                                in LeaveActivity.details (retrospective approval)
 *      - 'Present'            -> NEVER overwritten; recorded as a conflict
 *      - 'Leave'              -> adopted (leaveId assigned), no status change
 *    Cancellation restores the pre-sync state recorded in syncSummary
 *    (prior status back, created rows deleted) — never inventing absent marks.
 */
import { PrismaClient, Prisma, Attendance } from '@prisma/client';

const prisma = new PrismaClient();

export const ACTIVE_STUDENT_STATUS = 'Active';
export const ATTENDANCE_STATUSES = ['Present', 'Absent', 'Late', 'Leave'] as const;
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const LEAVE_CATEGORIES = [
  'Illness',
  'Medical appointment',
  'Family emergency',
  'Personal reasons',
  'Travel',
  'Other',
] as const;

// ---------------------------------------------------------------------------
// Day-key helpers (mirror index.ts conventions)
// ---------------------------------------------------------------------------

export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function utcMidnight(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

export function attendanceDayKey(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : localDayKey(new Date(value));
}

export function toDateStr(d: Date | string | number | null | undefined): string {
  if (!d) return '';
  const date = new Date(d);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Working days, weekly offs, holidays
// ---------------------------------------------------------------------------

export async function getWeeklyOffDays(): Promise<string[]> {
  const institute = await prisma.institute.findFirst({
    select: { weeklyOffDays: true },
  });
  return (institute?.weeklyOffDays as string[] | undefined) ?? [];
}

/** All holiday dates (inclusive of multi-day ranges) between start and end, as day keys. */
export async function listHolidayDayKeys(rangeStart: string, rangeEnd: string): Promise<Set<string>> {
  const startUtc = utcMidnight(rangeStart);
  const endUtc = utcMidnight(rangeEnd);
  const rows = await prisma.holiday.findMany({
    where: {
      startDate: { lte: endUtc },
      OR: [{ endDate: { gte: startUtc } }, { startDate: { gte: startUtc } }],
    },
  });
  console.error('DEBUG holidays rows:', rows.length, rows.map((r) => ({ id: r.id, start: r.startDate, end: r.endDate })), { startUtc, endUtc   });
  const keys = new Set<string>();
  for (const h of rows) {
    const from = attendanceDayKey(toDateStr(h.startDate));
    const to = h.endDate ? attendanceDayKey(toDateStr(h.endDate)) : from;
    const stopUtc = utcMidnight(to) <= endUtc ? utcMidnight(to) : endUtc
    let cursor = utcMidnight(from);
    // Bounded walk; holidays are short so no infinite-loop risk with sane data.
    let guard = 0;
    while (cursor && utcMidnight(cursor) <= stopUtc && guard < 400) {
      if (utcMidnight(cursor) >= startUtc) keys.add(cursor);
      const next = new Date(utcMidnight(cursor));
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = localDayKey(new Date(next.toISOString()));
      guard += 1;
    }
  }
  return keys;
}

/**
 * All calendar dates in [start, end] as day keys with working-day flags.
 * Weekly closures come from the institute configuration (weeklyOffDays).
 */
export async function calendarDaysBetween(startKey: string, endKey: string): Promise<Array<{ date: string; working: boolean; weeklyOff: boolean; holiday: boolean }>> {
  if (utcMidnight(endKey) < utcMidnight(startKey)) return [];
  const [weeklyOffs, holidayKeys] = await Promise.all([
    getWeeklyOffDays(),
    listHolidayDayKeys(startKey, endKey),
  ]);
  const weeklySet = new Set(weeklyOffs.map((d) => d.toLowerCase()));
  const out: Array<{ date: string; working: boolean; weeklyOff: boolean; holiday: boolean }> = [];
  let cursor = utcMidnight(startKey);
  const end = utcMidnight(endKey);
  while (cursor <= end && out.length < 400) {
    const key = localDayKey(new Date(cursor.toISOString()));
    const weekday = DAY_NAMES[cursor.getUTCDay()]; // utcMidnight keeps UTC parts aligned
    const weeklyOff = weeklySet.has(weekday.toLowerCase());
    const holiday = holidayKeys.has(key);
    out.push({ date: key, working: !weeklyOff && !holiday, weeklyOff, holiday });
    const next = new Date(cursor);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next;
  }
  return out;
}

/** Calendar days requested vs actual school working days affected. */
export async function leaveDayCounts(startKey: string, endKey: string) {
  const days = await calendarDaysBetween(startKey, endKey);
  const working = days.filter((d) => d.working).map((d) => d.date);
  return {
    calendarDays: days.length,
    workingDays: working.length,
    workingDates: working,
    weeklyOffDates: days.filter((d) => d.weeklyOff).map((d) => d.date),
    holidayDates: days.filter((d) => d.holiday).map((d) => d.date),
  };
}

// ---------------------------------------------------------------------------
// Role scope resolution (tenant/ownership isolation substitute)
// ---------------------------------------------------------------------------

export type LeaveScope =
  | { kind: 'all' }
  | { kind: 'classIds'; classIds: string[] }
  | { kind: 'studentIds'; studentIds: string[] };

/**
 * The backend database is a single-institution store (no tenant columns exist
 * anywhere in the schema; Institute is a singleton profile). "Multi-tenant
 * isolation" therefore equals role-scoped ownership access, enforced here:
 *   - Admin                        -> everything
 *   - Parent (User with Parent role) -> Parent.students relation only
 *   - Teacher                      -> attendance-permission classes only
 *   - Student                      -> own record only
 */
export async function resolveLeaveScope(auth: { id: string; role: string }): Promise<LeaveScope> {
  if (auth.role === 'Admin') return { kind: 'all' };

  if (auth.role === 'Teacher') {
    const teacher = await prisma.teacher.findUnique({
      where: { id: auth.id },
      include: { classes: true, permission: true },
    });
    if (!teacher) return { kind: 'classIds', classIds: [] };
    const mode = teacher.permission?.attendanceMode ?? 'assigned';
    if (mode === 'all') return { kind: 'all' };
    if (mode === 'specific') {
      const ids = (teacher.permission?.attendanceClassIds as string[]) || [];
      return { kind: 'classIds', classIds: ids };
    }
    if (mode === 'none') return { kind: 'classIds', classIds: [] };
    return { kind: 'classIds', classIds: (teacher.classes || []).map((c: any) => c.id) };
  }

  if (auth.role === 'Parent') {
    const user = await prisma.user.findUnique({
      where: { id: auth.id },
      include: { parent: { include: { students: { select: { id: true } } } } },
    });
    const ids = (user?.parent?.students || []).map((s: any) => s.id);
    return { kind: 'studentIds', studentIds: ids };
  }

  // Student: own record only.
  return { kind: 'studentIds', studentIds: [auth.id] };
}

/** Can the user review (approve/reject/cancel approved) applications for a student? */
export async function canReviewFor(auth: { id: string; role: string }, studentId: string): Promise<boolean> {
  if (auth.role === 'Admin') return true;
  if (auth.role !== 'Teacher') return false;
  const scope = await resolveLeaveScope(auth);
  if (scope.kind === 'all') return true;
  if (scope.kind !== 'classIds' || scope.classIds.length === 0) return false;
  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { class: true, section: true } });
  if (!student) return false;
  const cls = await prisma.schoolClass.findFirst({ where: { name: student.class, section: student.section } });
  return !!cls && scope.classIds.includes(cls.id);
}

// ---------------------------------------------------------------------------
// Notifications (existing Notification model — User accounts only)
// ---------------------------------------------------------------------------

async function adminUserIds(): Promise<string[]> {
  const admins = await prisma.user.findMany({ where: { role: 'Admin' }, select: { id: true } });
  return admins.map((a) => a.id);
}

/**
 * In-app notifications go to User accounts (admins / parent users). Teacher and
 * student portals have no Notification rows (they authenticate via TeacherLogin /
 * StudentLogin and there is no User-model channel for them — consistent with the
 * existing announcement infrastructure which targets Users or lists them read-only).
 */
export async function notifyUsers(userIds: string[], title: string, body?: string): Promise<void> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return;
  await prisma.notification.createMany({
    data: unique.map((userId) => ({ userId, title, body: body ?? null })),
  });
}

/** Notify all admins plus the applicant when the applicant is a Parent (User row). */
export async function notifyLeaveInterestedParties(leave: { id: string; studentName?: string; applicantId: string; applicantRole: string, applicantName?: string }, title: string, body?: string): Promise<void> {
  const ids = await adminUserIds();
  if (leave.applicantRole === 'Parent') ids.push(leave.applicantId);
  await notifyUsers(ids, title, body);
}

// ---------------------------------------------------------------------------
// Attendance synchronization engine
// ---------------------------------------------------------------------------

export interface SyncResult {
  leaveId: string;
  studentId: string;
  created: string[];             // new 'Leave' rows
  overwritten: Array<{ date: string; prior: string }>; // Absent/Late -> Leave
  adopted: string[];             // existing 'Leave' rows now linked
  skippedPresent: string[];      // conflicts — never touched
  halfDayNoted: string[];        // HALF_DAY leave working days (no attendance change)
  totalWorkingDays: number;
  syncedToLeave: number;
}

/**
 * Idempotent attendance synchronization for one approved leave. Safe to re-run:
 * rows already linked to this leave are left untouched, Present rows are never
 * overwritten, and half-day leaves never create or alter attendance rows.
 */
export async function syncApprovedLeaveToAttendance(leaveId: string): Promise<SyncResult> {
  const leave = await prisma.leave.findUnique({ where: { id: leaveId } });
  if (!leave) throw new Error('Leave not found');

  const startKey = attendanceDayKey(toDateStr(leave.startDate));
  const endKey = attendanceDayKey(toDateStr(leave.endDate));
  const counts = await leaveDayCounts(startKey, endKey);

  const result: SyncResult = {
    leaveId: leave.id,
    studentId: leave.studentId,
    created: [],
    overwritten: [],
    adopted: [],
    skippedPresent: [],
    halfDayNoted: [],
    totalWorkingDays: counts.workingDays,
    syncedToLeave: 0,
  };

  if (leave.leaveType === 'HALF_DAY') {
    // Day-level attendance cannot express a half-day; the register stays with
    // the regular workflow. We only surface the half-day days for the audit.
    result.halfDayNoted = counts.workingDates;
    await prisma.leave.update({
      where: { id: leave.id },
      data: { attendanceSyncedAt: new Date(), syncSummary: result as any },
    });
    return result;
  }

  const from = utcMidnight(startKey);
  const to = utcMidnight(endKey);
  const rows = await prisma.attendance.findMany({
    where: { studentId: leave.studentId, date: { gte: from, lte: to } },
  });
  const byKey = new Map(rows.map((r: Attendance) => [toDateStr(r.date), r]));

  const ops: Prisma.PrismaPromise<any>[] = [];
  for (const date of counts.workingDates) {
    const existing = byKey.get(date);
    if (!existing) {
      ops.push(prisma.attendance.create({
        data: { studentId: leave.studentId, date: utcMidnight(date), status: 'Leave', leaveId: leave.id },
      }));
      result.created.push(date);
    } else if (existing.leaveId === leave.id) {
      // Already synchronized — idempotent no-op.
    } else if ((existing.status || '').toLowerCase() === 'present') {
      result.skippedPresent.push(date);
    } else if ((existing.status || '').toLowerCase() === 'leave' && existing.leaveId) {
      // Excused by a different/approved leave — flag; never silently steal.
      result.skippedPresent.push(date);
    } else if ((existing.status || '').toLowerCase() === 'leave') {
      ops.push(prisma.attendance.update({
        where: { id: existing.id },
        data: { leaveId: leave.id },
      }));
      result.adopted.push(date);
    } else {
      ops.push(prisma.attendance.update({
        where: { id: existing.id },
        data: { status: 'Leave', leaveId: leave.id },
      }));
      result.overwritten.push({ date, prior: existing.status });
    }
  }

  if (ops.length > 0) {
    await prisma.$transaction(ops);
  }
  result.syncedToLeave = result.created.length + result.overwritten.length + result.adopted.length;

  await prisma.leave.update({
    where: { id: leave.id },
    data: { attendanceSyncedAt: new Date(), syncSummary: result as any },
  });

  return result;
}

/**
 * Reconciliation when a synced leave is cancelled/approval reversed:
 *   - rows this leave created -> delete (day returns to "not marked")
 *   - rows this leave overwrote -> restore the recorded prior status
 *   - rows merely adopted -> unlink (status stays 'Leave' if it was a Leave)
 * Rows now owned by a different leave or edited by a teacher afterwards are
 * never reset (we consider subsequent legitimate changes).
 */
export async function reconcileCancelledLeave(leaveId: string): Promise<{ restored: Array<{ date: string; prior: string }>; deleted: string[]; kept: string[] }> {
  const leave = await prisma.leave.findUnique({ where: { id: leaveId } });
  if (!leave) throw new Error('Leave not found');

  const summary = (leave.syncSummary || {}) as Partial<SyncResult>;
  const priorMap = new Map((summary.overwritten || []).map((o) => [o.date, o.prior]));
  const createdSet = new Set(summary.created || []);

  const rows = await prisma.attendance.findMany({ where: { leaveId } });

  const restored: Array<{ date: string; prior: string }> = [];
  const deleted: string[] = [];
  const kept: string[] = [];

  const ops: Prisma.PrismaPromise<any>[] = [];
  for (const row of rows) {
    const key = toDateStr(row.date);
    const normalized = (row.status || '').toLowerCase();
    const isStillSyncedValue = normalized === 'leave';
    if (!isStillSyncedValue) {
      // A teacher (or another workflow) legitimately changed this row after the
      // sync ran — never revert subsequent legitimate attendance changes.
      kept.push(key);
      continue;
    }
    if (createdSet.has(key)) {
      // The sync created this row; remove it so the day is unmarked again.
      ops.push(prisma.attendance.delete({ where: { id: row.id } }));
      deleted.push(key);
    } else {
      const prior = priorMap.get(key);
      ops.push(prisma.attendance.update({
        where: { id: row.id },
        data: prior && prior !== 'Leave'
          ? { status: prior, leaveId: null }
          : { leaveId: null },
      }));
      if (prior && prior !== 'Leave') restored.push({ date: key, prior });
      else kept.push(key);
    }
  }
  if (ops.length > 0) {
    await prisma.$transaction(ops);
  }

  // The leave no longer owns anything in the register.
  await prisma.leave.update({
    where: { id: leaveId },
    data: {
      attendanceSyncedAt: null,
      syncSummary: Prisma.DbNull,
    },
  });

  return { restored, deleted, kept };
}

// ---------------------------------------------------------------------------
// Conflict checks used by application + approval flows
// ---------------------------------------------------------------------------

/**
 * Existing data conflicts for a requested range on one student:
 * overlapping applications and existing attendance rows. Used to warn
 * reviewers (Scenario C: Present must never be silently overwritten) and to
 * stop duplicate or contradicting submissions.
 */
export async function findLeaveConflicts(studentId: string, startKey: string, endKey: string, excludeLeaveId?: string) {
  const from = utcMidnight(startKey);
  const to = utcMidnight(endKey);

  const overlapping = await prisma.leave.findMany({
    where: {
      studentId,
      status: { in: ['PENDING', 'APPROVED'] },
      startDate: { lte: to },
      endDate: { gte: from },
      ...(excludeLeaveId ? { id: { not: excludeLeaveId } } : {}),
    },
    include: { student: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const attendance = await prisma.attendance.findMany({
    where: { studentId, date: { gte: from, lte: to } },
    select: { date: true, status: true, leaveId: true },
  });

  return {
    overlappingApplications: overlapping.map((l) => ({
      id: l.id,
      studentId: l.studentId,
      studentName: (l as any).student?.name || null,
      status: l.status,
      leaveType: l.leaveType,
      startDate: toDateStr(l.startDate),
      endDate: toDateStr(l.endDate),
      category: l.category,
    })),
    presentDays: attendance
      .filter((a: any) => (a.status || '').toLowerCase() === 'present')
      .map((a: any) => toDateStr(a.date)),
    leaveDays: attendance
      .filter((a: any) => (a.status || '').toLowerCase() === 'leave' && a.leaveId)
      .map((a: any) => toDateStr(a.date)),
  };
}
