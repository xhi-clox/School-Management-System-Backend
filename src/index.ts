import 'express-async-errors';
import 'dotenv/config';
import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { z } from 'zod';
import { addMonths, differenceInCalendarDays, startOfDay } from 'date-fns';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { authMiddleware } from './auth';
import { checkRole } from './checkRole';
import errorHandler from './middleware/errorHandler';
import isMissingColumn from './missing-column';
import { validateGradingBands, defaultComponentConfig } from './grading-validation';
import {
  netPaid,
  invoiceBalance,
  getFeeState,
  lockInvoice,
  recalcInvoiceTx,
  logAudit,
  nextPaymentNumber,
  nextInvoiceNumber,
  academicYearForDate,
  academicYearForMonth,
  normalizeAcademicYear,
  billingMonthStr,
  isVoided,
  PAYMENT_METHODS,
  roundMoney as feeRoundMoney,
} from './fees/shared';
import { refreshRecordStatus } from './fees/records';
import feesRouter from './fees/routes';
import leavesRouter from './leaves/routes';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}


const app = express();

// Email transporter for password reset and other notifications
// In development, logs emails to console. In production, configure SMTP via .env
const mailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.ethereal.email',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || 'ethereal-user',
    pass: process.env.SMTP_PASS || 'ethereal-pass',
  },
});

async function sendPasswordResetEmail(email: string, resetUrl: string) {
  const info = await mailTransporter.sendMail({
    from: process.env.SMTP_FROM || 'noreply@sms-school.local',
    to: email,
    subject: 'Reset Your Password - School Management System',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #0075ff;">Password Reset Request</h2>
        <p>You requested a password reset for your School Management System account.</p>
        <p>Click the button below to reset your password. This link expires in 15 minutes:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="background-color: #0075ff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset Password</a>
        </div>
        <p style="color: #666; font-size: 14px;">If you didn't request this reset, please ignore this email.</p>
        <p style="color: #666; font-size: 14px;">If the button doesn't work, copy and paste this link into your browser:<br/>${resetUrl}</p>
      </div>
    `,
  });
  console.log('Password reset email sent:', info.messageId);
  return info;
}

// Serialize Prisma.Decimal money values as plain numbers so the frontend keeps receiving numbers.
// decimal.js's default toJSON() returns a string, so patch it before Express serializes anything.
(Prisma.Decimal.prototype as any).toJSON = function (this: Prisma.Decimal) {
  return this.toNumber();
};
app.set('json replacer', (_key: string, value: unknown) =>
  value instanceof Prisma.Decimal ? value.toNumber() : value
);

const money = (v: any): Prisma.Decimal => new Prisma.Decimal(v ?? 0);
const roundMoney = (v: any): Prisma.Decimal => money(v).toDecimalPlaces(2);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Every income/expense/profit total must ignore ledger rows that a void has
 * cancelled. A reversed row is kept for audit but no longer represents money
 * that came in or went out. Spread this into the `where` of *all* LedgerEntry
 * reads and aggregates; omitting it silently reinstates the double-count.
 */
const ACTIVE_LEDGER = { reversedAt: null } as const;

/**
 * Only students on roll ('Active') may be marked, counted or tallied.
 *
 * Student.status is free text and also carries 'Inactive', 'Graduated',
 * 'Withdrawn', ... Those students must never appear on a register or be
 * included in any attendance statistic, otherwise they deflate every
 * percentage (they count as unmarked/absent days that were never their fault).
 * Spread into the `where` of every attendance read, write and aggregate.
 */
const ACTIVE_STUDENT_STATUS = 'Active' as const;

// Before helmet/cors/body parsers so platform health probes always get a fast 200
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    commit: process.env.RENDER_GIT_COMMIT || null,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: 'Academify School Management System API',
    status: 'running',
    message: 'API is running',
  });
});

/** Always merged with CORS_ORIGINS so Railway env cannot accidentally drop the production frontend. */
const DEFAULT_CORS_ORIGINS = [
  'https://school-management-system-vkqo.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const extraOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOrigins = new Set([...DEFAULT_CORS_ORIGINS, ...extraOrigins]);

// âœ… Better Vercel matcher (handles ALL preview URLs)
const isVercelPreviewOrigin = (origin: string) =>
  /^https:\/\/.*\.vercel\.app$/i.test(origin);

const corsOptions: cors.CorsOptions = {
  origin: true, // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  optionsSuccessStatus: 200,
};

// Require JWT_SECRET to be set; do not accept fallback secrets
if (!process.env.JWT_SECRET) {
  throw new Error('Server misconfigured: JWT_SECRET environment variable is required');
}

// CORS before helmet so OPTIONS preflight always gets ACAO / ACAH / ACAM
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(morgan('dev'));

// Handle unhandled rejections at process level
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

import {
  isCloudinaryConfigured,
  isBase64Image,
  uploadBase64Image,
} from './cloudinary';

class ImageUploadGuardError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Convert any base64 image in the request body (avatar/photo/logo) into a
// Cloudinary URL before routes store it, so photo bytes never bloat the DB.
app.use(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.body || typeof req.body !== 'object') return next();

  const MAX_BASE64_LENGTH = 4_500_000;

  try {
    const walk = async (node: any): Promise<any> => {
      if (typeof node === 'string') {
        if (isBase64Image(node)) {
          if (node.length > MAX_BASE64_LENGTH) {
            throw new ImageUploadGuardError(
              'Image is too large (max ~3 MB). Please upload a smaller photo.',
              400
            );
          }
          if (!isCloudinaryConfigured()) {
            // No Cloudinary configured: keep the data URL so uploads still work locally.
            return node;
          }
          return await uploadBase64Image(node);
        }
        return node;
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) node[i] = await walk(node[i]);
        return node;
      }
      if (node && typeof node === 'object') {
        for (const key of Object.keys(node)) {
          node[key] = await walk(node[key]);
        }
        return node;
      }
      return node;
    };

    await walk(req.body);
    next();
  } catch (error: any) {
    console.error('Image upload error:', error);
    return res
      .status(error.statusCode || 500)
      .json({ error: error.message || 'Image upload failed. Please try again.' });
  }
});

app.get('/test-db', async (_req: Request, res: Response) => {
  try {
    const count = await prisma.user.count();
    res.json({ ok: true, userCount: count });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin / personal profile
app.get('/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const auth = (req as any).user as { id: string; role: string };
    let profile: any = null;

    if (auth.role === 'Admin') {
      const user = await prisma.user.findUnique({
        where: { id: auth.id },
        select: {
          id: true,
          email: true,
          role: true,
          name: true,
          phone: true,
          address: true,
          department: true,
          designation: true,
          avatar: true,
          createdAt: true,
        },
      });
      profile = user;
    } else if (auth.role === 'Teacher') {
      const teacher = await prisma.teacher.findUnique({
        where: { id: auth.id },
        select: { id: true, name: true, email: true, phone: true, avatar: true, subject: true, designation: true },
      });
      profile = teacher ? { ...teacher, role: 'Teacher', department: 'Teaching Staff' } : null;
    } else if (auth.role === 'Student') {
      const student = await prisma.student.findUnique({
        where: { id: auth.id },
        select: { id: true, name: true, email: true, phone: true, avatar: true, class: true, section: true, roll: true, admissionNo: true, gender: true },
      });
      profile = student ? { ...student, role: 'Student' } : null;
    }

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json(profile);
  } catch (error: any) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.put('/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const auth = (req as any).user as { id: string; role: string };
    const { name, phone, address, department, designation, avatar, email } = req.body;

    if (auth.role !== 'Admin') {
      return res.status(403).json({ error: 'Only admin accounts can update this profile' });
    }

    // Validate email uniqueness if changing email
    if (email !== undefined && email !== null && email !== '') {
      const existing = await prisma.user.findFirst({
        where: { email, id: { not: auth.id } },
      });
      if (existing) {
        return res.status(409).json({ error: 'Email already in use by another account' });
      }
    }

    const updated = await prisma.user.update({
      where: { id: auth.id },
      data: {
        name: name ?? null,
        email: email ?? null,
        phone: phone ?? null,
        address: address ?? null,
        department: department ?? null,
        designation: designation ?? null,
        avatar: avatar ?? null,
      },
      select: {
        id: true,
        email: true,
        role: true,
        name: true,
        phone: true,
        address: true,
        department: true,
        designation: true,
        avatar: true,
      },
    });
    res.json(updated);
  } catch (error: any) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Notifications
app.get('/notifications', authMiddleware, async (req: Request, res: Response) => {
  try {
    const auth = (req as any).user as { id: string; role: string };
    const notifications = await prisma.notification.findMany({
      where: { userId: auth.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(notifications);
  } catch (error: any) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.post('/notifications/:id/read', authMiddleware, async (req: Request, res: Response) => {
  try {
    const auth = (req as any).user as { id: string; role: string };
    const updated = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: auth.id },
      data: { read: true },
    });
    res.json({ success: true, updated: updated.count });
  } catch (error: any) {
    console.error('Error marking notification read:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

app.post('/notifications/read-all', authMiddleware, async (req: Request, res: Response) => {
  try {
    const auth = (req as any).user as { id: string; role: string };
    const updated = await prisma.notification.updateMany({
      where: { userId: auth.id, read: false },
      data: { read: true },
    });
    res.json({ success: true, updated: updated.count });
  } catch (error: any) {
    console.error('Error marking all notifications read:', error);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

// Dashboard Stats
// Short-lived per-user cache: this endpoint fans out to dozens of queries,
// so repeat loads within the TTL skip all of them and return instantly.
const DASH_STATS_TTL_MS = 60_000;
const dashStatsCache = new Map<string, { at: number; body: any }>();
app.get('/dashboard/stats', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
  const user = (req as any).user;  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  // Attendance.date is a date-only key stored at UTC midnight. Use the day
  // displayed by the client when supplied; otherwise fall back to server-local today.
  const requestedAttendanceDay = req.query.date === undefined
    ? localDayKey(now)
    : String(req.query.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedAttendanceDay)) {
    return res.status(400).json({ error: 'Attendance date must use YYYY-MM-DD format' });
  }
  const attStart = utcMidnight(requestedAttendanceDay);
  if (Number.isNaN(attStart.getTime()) || attStart.toISOString().slice(0, 10) !== requestedAttendanceDay) {
    return res.status(400).json({ error: 'Attendance date is invalid' });
  }
  const attEnd = new Date(attStart);
  attEnd.setUTCDate(attEnd.getUTCDate() + 1);

  const dashCacheKey = `${user?.role ?? ''}:${user?.id ?? ''}:${requestedAttendanceDay}`;
  const dashCached = dashStatsCache.get(dashCacheKey);
  if (dashCached && Date.now() - dashCached.at < DASH_STATS_TTL_MS) {
    return res.json(dashCached.body);
  }

  // Scope student counts to the teacher's head-teacher classes so the
  // dashboard matches what the teacher sees on the Students page.
  let studentWhere: any = {};
  if (user && user.role === 'Teacher') {
    const teacher = await prisma.teacher.findUnique({ where: { id: user.id } });
    if (teacher) {
      const classes = await prisma.schoolClass.findMany({
        where: { teacher: { id: teacher.id } },
        select: { name: true, section: true }
      });
      studentWhere = classes.length > 0
        ? { OR: classes.map((c) => ({ class: c.name, section: c.section })) }
        : { id: '__none__' };
    }
  }

  const [
    totalStudents,
    activeStudents,
    teachersCount,
    inactiveTeachers,
    classesCount,
    staffCount,
    todayAttendanceRaw,
    recentActivity,
    upcomingExams
  ] = await Promise.all([
    prisma.student.count({ where: studentWhere }),
    prisma.student.count({ where: { ...studentWhere, status: 'Active' } }),
    prisma.teacher.count(),
    prisma.teacher.count({ where: { status: { not: 'Active' } } }),
    prisma.schoolClass.count(),
    prisma.staff.count(),
    prisma.attendance.findMany({
      // Scoped to on-roll students: an inactive/graduated student's saved row
      // must not contribute to today's counts or the absent-students list.
      // `studentWhere` also applies the teacher's class scope, so a teacher's
      // marked total can never exceed the active students they can see -
      // otherwise the "marked out of" progress bar would read above 100%.
      where: {
        date: { gte: attStart, lt: attEnd },
        student: { AND: [studentWhere, { status: ACTIVE_STUDENT_STATUS }] },
      },
      select: {
        studentId: true,
        status: true,
        student: {
          select: {
            id: true,
            name: true,
            admissionNo: true,
            avatar: true,
            class: true,
            section: true,
            roll: true,
            status: true,
            phone: true,
            guardianPhone: true,
            fatherName: true,
            motherName: true,
            guardian: {
              select: { guardianName: true, guardianPhone: true, fatherPhone: true, motherPhone: true }
            },
          }
        }
      }
    }),
    prisma.student.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: { name: true, createdAt: true, class: true }
    }),
    prisma.examSchedule.findMany({
      where: { date: { gte: new Date() } },
      include: { subject: true, exam: true, class: true },
      orderBy: { date: 'asc' },
      take: 5
    })
  ]);

  const inactiveStudents = totalStudents - activeStudents;
  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();
  const mStart = new Date(currentYear, currentMonth, 1);
  const mEnd = new Date(currentYear, currentMonth + 1, 1);

  // All ledger sums (month / today / 6-month / daily / yearly) come from ONE
  // bounded read + JS bucketing. ledgerEntry has no createdAt index, so the
  // old per-bucket aggregates (~100 full table scans per load) were the main
  // dashboard bottleneck.
  const histFloor = new Date(currentYear, currentMonth - 5, 1);
  const [recentEntries, allTimeIncome, allTimeExpense] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { ...ACTIVE_LEDGER, createdAt: { gte: histFloor } },
      select: { type: true, amount: true, createdAt: true },
    }),
    prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { ...ACTIVE_LEDGER, type: 'income' }
    }),
    prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { ...ACTIVE_LEDGER, type: 'expense' }
    }),
  ]);

  const num = (v: any) => money(v).toNumber();
  let monthIncomeAmt = 0;
  let monthExpenseAmt = 0;
  let todayIncomeAmt = 0;
  let todayExpenseAmt = 0;
  // Build 6-month history buckets (oldest -> newest).
  const historyRanges = Array.from({ length: 6 }, (_, k) => {
    const i = 5 - k;
    return {
      histStart: new Date(currentYear, currentMonth - i, 1),
      histEnd: new Date(currentYear, currentMonth - i + 1, 1),
    };
  });
  const histIncByKey = new Map<number, number>(historyRanges.map((r) => [r.histStart.getTime(), 0]));
  const histExpByKey = new Map<number, number>(historyRanges.map((r) => [r.histStart.getTime(), 0]));
  // Daily history for the current month (day 1 -> today).
  const todayDay = new Date().getDate();
  const dailyInc = new Array<number>(todayDay).fill(0);
  const dailyExp = new Array<number>(todayDay).fill(0);
  // Yearly history for the current year (Jan -> current month).
  const yearlyInc = new Array<number>(currentMonth + 1).fill(0);
  const yearlyExp = new Array<number>(currentMonth + 1).fill(0);

  const mStartT = mStart.getTime();
  const mEndT = mEnd.getTime();
  const todayStartT = todayStart.getTime();
  const todayEndT = todayEnd.getTime();
  for (const e of recentEntries) {
    const amt = num(e.amount);
    const d = new Date(e.createdAt);
    const t = d.getTime();
    const isInc = e.type === 'income';
    if (t >= mStartT && t < mEndT) {
      if (isInc) monthIncomeAmt += amt; else monthExpenseAmt += amt;
    }
    if (t >= todayStartT && t < todayEndT) {
      if (isInc) todayIncomeAmt += amt; else todayExpenseAmt += amt;
    }
    const monthKey = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    if (histIncByKey.has(monthKey)) {
      if (isInc) histIncByKey.set(monthKey, (histIncByKey.get(monthKey) ?? 0) + amt);
      else histExpByKey.set(monthKey, (histExpByKey.get(monthKey) ?? 0) + amt);
    }
    if (d.getFullYear() === currentYear && d.getMonth() === currentMonth && d.getDate() >= 1 && d.getDate() <= todayDay) {
      if (isInc) dailyInc[d.getDate() - 1] += amt; else dailyExp[d.getDate() - 1] += amt;
    }
    if (d.getFullYear() === currentYear && d.getMonth() <= currentMonth) {
      if (isInc) yearlyInc[d.getMonth()] += amt; else yearlyExp[d.getMonth()] += amt;
    }
  }

  const historyIncome = historyRanges.map((r) => ({ date: r.histStart, amount: round2(histIncByKey.get(r.histStart.getTime()) ?? 0) }));
  const historyExpense = historyRanges.map((r) => ({ date: r.histStart, amount: round2(histExpByKey.get(r.histStart.getTime()) ?? 0) }));
  const dailyIncome = dailyInc.map((amount, idx) => ({ date: new Date(currentYear, currentMonth, idx + 1), amount: round2(amount) }));
  const dailyExpense = dailyExp.map((amount, idx) => ({ date: new Date(currentYear, currentMonth, idx + 1), amount: round2(amount) }));
  const yearlyIncome = yearlyInc.map((amount, m) => ({ date: new Date(currentYear, m, 1), amount: round2(amount) }));
  const yearlyExpense = yearlyExp.map((amount, m) => ({ date: new Date(currentYear, m, 1), amount: round2(amount) }));

  const studentsPerClass = await prisma.student.groupBy({
    by: ['class'],
    _count: { id: true }
  });

  // On-roll headcount per class, used as the denominator for the dashboard's
  // per-class attendance marking progress. Scoped the same way as today's
  // attendance rows above (teacher class scope + active status), so a class can
  // never report more marked students than it has students.
  const activeStudentsPerClass = await prisma.student.groupBy({
    by: ['class'],
    where: { AND: [studentWhere, { status: ACTIVE_STUDENT_STATUS }] },
    _count: { id: true }
  });

  const feeInvoices = await prisma.invoice.findMany({
    select: {
      totalAmount: true,
      dueDate: true,
      billingMonth: true,
      payments: { select: { amount: true, status: true, date: true } }
    }
  });
  // Void-aware fee stats (mirrors /finance/fees/summary). Invoices are the
  // single source of truth; feesDue = total outstanding, feeOverdue is the
  // subset past dueDate, feeExpectedMonth = outstanding on the current
  // billing month's generated invoices, feeCollectedToday + todayTransactions
  // = non-voided payments received today.
  let feesDue = money(0);
  let feesCollected = money(0);
  let feeOverdue = money(0);
  let feeExpectedMonth = money(0);
  let feeCollectedToday = money(0);
  let feeTodayTransactions = 0;
  const todayKey = localDayKey(now);
  const currentMonthKey = billingMonthStr(now.getFullYear(), now.getMonth() + 1);
  for (const inv of feeInvoices) {
    const paid = netPaid(inv.payments);
    feesCollected = feesCollected.plus(paid);
    const balance = money(inv.totalAmount).minus(paid);
    if (balance.gt(0)) {
      feesDue = feesDue.plus(balance);
      if (getFeeState(balance, inv.dueDate, now) === 'OVERDUE') feeOverdue = feeOverdue.plus(balance);
      if (inv.billingMonth === currentMonthKey) feeExpectedMonth = feeExpectedMonth.plus(balance);
    }
    for (const p of inv.payments) {
      if (isVoided(p)) continue;
      if (localDayKey(new Date(p.date)) === todayKey) {
        feeCollectedToday = feeCollectedToday.plus(p.amount);
        feeTodayTransactions += 1;
      }
    }
  }

  const incomeTotal = money(allTimeIncome._sum.amount);
  const expenseTotal = money(allTimeExpense._sum.amount);
  const totalBalance = incomeTotal.minus(expenseTotal);

  const seenStudents = new Set<string>();
  const uniqueToday = todayAttendanceRaw.filter((r) => (seenStudents.has(r.studentId) ? false : (seenStudents.add(r.studentId), true)));
  const normalizedStatuses = uniqueToday.map((r) => String(r.status || '').trim().toLowerCase());
  const absent = normalizedStatuses.filter((s) => s === 'absent' || s === 'a').length;
  const late = normalizedStatuses.filter((s) => s === 'late' || s === 'l').length;
  const onLeave = normalizedStatuses.filter((s) => s === 'leave' || s === 'lv' || s === 'on leave' || s === 'on-leave' || s === 'half-day' || s === 'h').length;
  const present = normalizedStatuses.filter((s) => s === 'present' || s === 'p').length;
  const totalForToday = uniqueToday.length;

  const absentStudents = buildAbsentStudents(uniqueToday);

  // History series (6-month / daily / yearly) were bucketed above from the
  // single bounded ledger read.

  // Per-class marking progress for the dashboard chart. Numerator comes from
  // the rows already loaded above; denominator from the on-roll groupBy. Classes
  // with no active students are dropped - there is no register to mark.
  const markedPerClass = new Map<string, number>();
  for (const r of uniqueToday) {
    const cls = r.student?.class;
    if (!cls) continue;
    markedPerClass.set(cls, (markedPerClass.get(cls) ?? 0) + 1);
  }

  const byClass = activeStudentsPerClass
    .map((g) => {
      const total = g._count.id;
      if (!g.class || total <= 0) return null;
      // `uniqueToday` is already restricted to active students, so marked
      // cannot exceed total. Clamped anyway so a stale row can't overflow.
      const marked = Math.min(total, markedPerClass.get(g.class) ?? 0);
      const pct = total > 0 ? Math.round((marked / total) * 100) : 0;
      return {
        class: g.class,
        total,
        marked,
        pct,
        state: pct >= 100 ? 'complete' : marked > 0 ? 'partial' : 'pending',
      };
    })
    .filter((c): c is { class: string; total: number; marked: number; pct: number; state: string } => c !== null)
    // Sorted worst-progress-first. Note the dashboard's by-class tiles
    // deliberately re-sort into academic order (see the frontend's
    // class-label module), so this ordering is not what the grid displays - it
    // only guarantees the classes needing attention are present in the payload
    // and keeps the tie-break stable.
    .sort((a, b) => a.pct - b.pct || a.class.localeCompare(b.class));

  const dashboardBody = {
    counts: {
      students: totalStudents,
      activeStudents,
      inactiveStudents,
      teachers: teachersCount,
      inactiveTeachers,
      classes: classesCount,
      staff: staffCount
    },
    financials: {
      income: incomeTotal,
      expense: expenseTotal,
      profit: incomeTotal.minus(expenseTotal),
      totalBalance,
      todayIncome: money(todayIncomeAmt),
      todayExpense: money(todayExpenseAmt),
      feesDue,
      feesCollected,
      feeOverdue: feeOverdue.toNumber(),
      feeExpectedMonth: feeExpectedMonth.toNumber(),
      feeCollectedToday: feeCollectedToday.toNumber(),
      todayTransactions: feeTodayTransactions,
      history: {
        income: historyIncome.map(h => ({ date: h.date, amount: h.amount })),
        expense: historyExpense.map(h => ({ date: h.date, amount: h.amount })),
        daily: {
          income: dailyIncome.map(h => ({ date: h.date, amount: h.amount })),
          expense: dailyExpense.map(h => ({ date: h.date, amount: h.amount }))
        },
        yearly: {
          income: yearlyIncome.map(h => ({ date: h.date, amount: h.amount })),
          expense: yearlyExpense.map(h => ({ date: h.date, amount: h.amount }))
        }
      }
    },
    todayAttendance: {
      total: totalForToday,
      present,
      absent,
      late,
      onLeave,
      absentStudents,
      byClass
    },
    upcomingExams: upcomingExams.map(ex => ({
      id: ex.id,
      subject: ex.subject.name,
      class: ex.class?.name || 'N/A',
      date: ex.date,
      time: ex.startTime
    })),
    enrollment: studentsPerClass.map(s => ({ name: s.class, value: s._count.id })),
    recentActivity: recentActivity.map(a => ({
      type: 'New Student',
      message: `${a.name} joined Class ${a.class}`,
      date: a.createdAt
    }))
  };

  // Cache briefly so repeat dashboard loads return instantly.
  if (dashStatsCache.size > 500) {
    const oldest = dashStatsCache.keys().next();
    if (!oldest.done) dashStatsCache.delete(oldest.value);
  }
  dashStatsCache.set(dashCacheKey, { at: Date.now(), body: dashboardBody });
  res.json(dashboardBody);
  } catch (error: any) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to load dashboard stats' });
  }
});

// Admin - Reset Data (Danger Zone: Clear All Data)
app.delete('/admin/reset-data', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    // Verify the reset token matches environment variable
    const resetToken = req.query.token ? String(req.query.token) : '';
    const expectedToken = process.env.RESET_DATA_TOKEN;
    
    if (!expectedToken || resetToken !== expectedToken) {
      return res.status(403).json({ error: 'Invalid or missing reset token' });
    }
    // Delete in FK-safe order: leaves -> roots. Keep User/Admin accounts + Institute profile.
    // Any failure is logged with details so frontend can show why.
    await prisma.$transaction(async (tx) => {
      // Exam / Result leaves - data only, tables remain (deleteMany preserves schema)
      await (tx as any).resultValidationRun.deleteMany();
      await (tx as any).resultPublish.deleteMany();
      await (tx as any).result.deleteMany();
      await (tx as any).examAttendance.deleteMany();
      await (tx as any).attendance.deleteMany();
      await (tx as any).teacherAttendance.deleteMany();
      await (tx as any).examSchedule.deleteMany();
      // Preset & master data preserved so Generate Schedule still works after reset (tables remain)
      // Do NOT delete: examPreset*, gradingSystem, product, supplier, subject, schoolClass, examType, feeParticular, feeStructure
      // Only clear transactional children that would block master deletes if we did

      // Finance / Invoice leaves
      await (tx as any).invoiceItem.deleteMany();
      await (tx as any).payment.deleteMany();
      await (tx as any).invoice.deleteMany();
      await (tx as any).studentFee.deleteMany();
      await (tx as any).studentFeeAssignment.deleteMany();

      // Student leaves
      await (tx as any).guardian.deleteMany();
      await (tx as any).studentLogin.deleteMany();
      await (tx as any).studentAcademicRecord.deleteMany();
      await (tx as any).ledgerEntry.deleteMany();
      await (tx as any).schoolExpense.deleteMany();

      // Teacher / class leaves
      await (tx as any).teacherSalary.deleteMany();
      await (tx as any).staffSalary.deleteMany();
      await (tx as any).teacherLogin.deleteMany();
      await (tx as any).teacherPermission.deleteMany();
      await (tx as any).classSubjectTeacher.deleteMany();
      await (tx as any).admissionFeeItem.deleteMany();
      await (tx as any).admissionPackage.deleteMany();
      await (tx as any).routineEntry.deleteMany();
      await (tx as any).routinePeriod.deleteMany();

      // Mid-level parents after leaves - keep master tables so Generate Schedule still works
      // Preserved: subject, schoolClass, examType, feeParticular, feeStructure, product, supplier, gradingSystem, examPreset*
      await (tx as any).exam.deleteMany();

      // Roots (students/teachers last after all children)
      await (tx as any).student.deleteMany();
      await (tx as any).teacher.deleteMany();
      await (tx as any).staff.deleteMany();
      await (tx as any).notification.deleteMany();
      // Keep User and Institute so admin can still log in. Optionally clear Parent orphan rows.
      await (tx as any).parent.deleteMany();
    }, { timeout: 30000, maxWait: 10000 });

    res.json({ success: true, message: 'All data has been reset. Users and institute preserved.' });
  } catch (error: any) {
    console.error('Reset error:', error);
    res.status(500).json({ error: 'Failed to reset data', details: error?.message || String(error) });
  }
});

// Dashboard: weekly attendance summary (grouped per day)
app.get('/dashboard/attendance/summary/weekly', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({
    startDate: z.string().min(1),
    endDate: z.string().min(1),
    email: z.string().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { startDate, endDate } = parsed.data as { startDate: string; endDate: string };

  const start = new Date(String(startDate));
  const end = new Date(String(endDate));

  try {
    const records = await prisma.attendance.findMany({
      // Only on-roll students, otherwise a student marked inactive mid-month
      // keeps dragging the weekly present/absent bars and rates down.
      where: { date: { gte: start, lte: end }, student: { status: ACTIVE_STUDENT_STATUS } },
      select: { date: true, status: true },
    });

    // `marked` counts every attendance row saved that day (including Leave), so
    // clients can tell "nobody was marked" apart from "everyone was marked absent".
    const dayMap = new Map<string, { present: number; absent: number; late: number; marked: number }>();
    for (const r of records) {
      const key = utcDayKeyOf(r.date);
      const entry = dayMap.get(key) || { present: 0, absent: 0, late: 0, marked: 0 };
      entry.marked++;
      const status = normalizeAttendanceStatus(r.status);
      if (status === 'Present') entry.present++;
      else if (status === 'Absent') entry.absent++;
      else if (status === 'Late') entry.late++;
      dayMap.set(key, entry);
    }

    const result: Array<{ date: string; present: number; absent: number; late: number; marked: number }> = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = utcDayKeyOf(d);
      result.push({ date: key, ...(dayMap.get(key) || { present: 0, absent: 0, late: 0, marked: 0 }) });
    }

    res.json(result);
  } catch (error) {
    console.error('Weekly attendance summary error:', error);
    res.status(500).json({ error: 'Failed to load weekly attendance summary' });
  }
});

/**
 * GET /dashboard/attendance/absentees?date=YYYY-MM-DD
 *
 * Absent students for one specific day, with every contact number the
 * click-to-call dialog needs. `/dashboard/stats` already covers today; this
 * exists so a past day can be drilled into from the dashboard's weekly chart.
 *
 * Scoped exactly like `/dashboard/stats` - a teacher only ever sees the
 * absentees from their own classes.
 */
app.get('/dashboard/attendance/absentees', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const requested = String(req.query.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
      return res.status(400).json({ error: 'date must use YYYY-MM-DD format' });
    }
    // Attendance.date is a date-only key stored at UTC midnight.
    const start = utcMidnight(requested);
    if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== requested) {
      return res.status(400).json({ error: 'date is invalid' });
    }
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    let studentWhere: any = {};
    if (user && user.role === 'Teacher') {
      const teacher = await prisma.teacher.findUnique({ where: { id: user.id } });
      if (!teacher) return res.json({ date: requested, absentees: [] });
      const classes = await prisma.schoolClass.findMany({
        where: { teacher: { id: teacher.id } },
        select: { name: true, section: true }
      });
      if (classes.length === 0) return res.json({ date: requested, absentees: [] });
      studentWhere = { OR: classes.map((c) => ({ class: c.name, section: c.section })) };
    }

    const rows = await prisma.attendance.findMany({
      where: {
        date: { gte: start, lt: end },
        // Off-roll students must not appear, matching the counts in the chart.
        student: { AND: [studentWhere, { status: ACTIVE_STUDENT_STATUS }] },
      },
      select: {
        studentId: true,
        status: true,
        student: {
          select: {
            id: true,
            name: true,
            admissionNo: true,
            avatar: true,
            class: true,
            section: true,
            roll: true,
            status: true,
            phone: true,
            guardianPhone: true,
            fatherName: true,
            motherName: true,
            guardian: {
              select: { guardianName: true, guardianPhone: true, fatherPhone: true, motherPhone: true }
            },
          }
        }
      }
    });

    // One row per student: a duplicate save for the same day must not list them twice.
    const seen = new Set<string>();
    const unique = rows.filter((r) => (seen.has(r.studentId) ? false : (seen.add(r.studentId), true)));

    const absentees = buildAbsentStudents(unique).sort((a, b) => (a.roll ?? 0) - (b.roll ?? 0));
    res.json({ date: requested, absentees });
  } catch (error: any) {
    console.error('Error fetching absentees for date:', error);
    res.status(500).json({ error: 'Failed to fetch absentees' });
  }
});
app.get('/dashboard/financial-details', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    type: z.enum(['income', 'expense', 'profit']),
    month: z.coerce.number().int().min(1).max(12).optional(),
    year: z.coerce.number().int().min(1970).max(2200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(10),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { type, month, year, limit } = parsed.data;

  const dateFilter = month && year
    ? { createdAt: { gte: new Date(year, month - 1, 1), lt: new Date(year, month, 1) } }
    : {};

  try {
    if (type === 'profit') {
      const income = await prisma.ledgerEntry.aggregate({
        _sum: { amount: true },
        where: { ...ACTIVE_LEDGER, type: 'income', ...dateFilter }
      });
      const expense = await prisma.ledgerEntry.aggregate({
        _sum: { amount: true },
        where: { ...ACTIVE_LEDGER, type: 'expense', ...dateFilter }
      });
      const incomeTotal = money(income._sum.amount);
      const expenseTotal = money(expense._sum.amount);
      return res.json({
        total: incomeTotal.minus(expenseTotal),
        incomeTotal,
        expenseTotal
      });
    }

    const where = { ...ACTIVE_LEDGER, type, ...dateFilter };
    const [grouped, entries] = await Promise.all([
      prisma.ledgerEntry.groupBy({
        by: ['category'],
        where,
        _sum: { amount: true }
      }),
      prisma.ledgerEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit
      })
    ]);

    const breakdown = grouped.map(g => ({ category: g.category, amount: money(g._sum.amount).toNumber() }));
    const total = grouped.reduce((s, g) => s.plus(money(g._sum.amount)), money(0));

    res.json({
      total,
      breakdown,
      entries: entries.map(e => ({ ...e, source: 'ledger' }))
    });
  } catch (error) {
    console.error('Financial details error:', error);
    res.status(500).json({ error: 'Failed to fetch financial details' });
  }
});

// Students
app.get('/students', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const user = (req as any).user;

  if (user.role === 'Teacher') {
    const teacher = await prisma.teacher.findUnique({ where: { id: user.id } });
    if (teacher) {
      const classes = await prisma.schoolClass.findMany({
        where: { teacher: { id: teacher.id } },
        select: { name: true, section: true }
      });
      if (classes.length === 0) {
        return res.json([]);
      }
      const students = await prisma.student.findMany({
        where: { OR: classes.map((c) => ({ class: c.name, section: c.section })) },
        orderBy: { createdAt: 'desc' }
      });
      return res.json(students);
    }
  }

  const students = await prisma.student.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(students);
});

app.get('/students/rolls/used', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  try {
    const { class: cls, section } = req.query;
    if (!cls) return res.status(400).json({ error: 'class is required' });
    const students = await prisma.student.findMany({
      where: {
        class: String(cls),
        ...(section ? { section: String(section) } : {}),
        roll: { gt: 0 }
      },
      select: { roll: true }
    });
    const rolls = students
      .map((s) => s.roll as number)
      .sort((a, b) => a - b);
    res.json({ rolls, nextRoll: rolls.length ? rolls[rolls.length - 1] + 1 : 1 });
  } catch (error: any) {
    console.error('Error fetching used rolls:', error);
    res.status(500).json({ error: 'Failed to fetch used rolls' });
  }
});

/**
 * GET /students/birthdays?days=30&class=&section=
 *
 * Upcoming birthdays, soonest first. `days` is a forward-looking window
 * (default 30, clamped to 1..366). A student whose birthday is today reports
 * `daysUntil: 0`, which is what the navbar alert keys off.
 *
 * `dob` is a full timestamp on the Student row, but only the month/day matter
 * here, so the year is recomputed onto the current (or next) year.
 *
 * NOTE: must stay ABOVE `app.get('/students/:id', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']))` â€” Express matches in
 * registration order, so `/students/birthdays` would be swallowed as an id.
 */
app.get('/students/birthdays', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const requestedDays = Number(req.query.days);
    const days = Number.isFinite(requestedDays)
      ? Math.min(366, Math.max(1, Math.floor(requestedDays)))
      : 30;
    const classFilter = req.query.class ? String(req.query.class) : undefined;
    const sectionFilter = req.query.section ? String(req.query.section) : undefined;

    const where: any = { dob: { not: null }, status: ACTIVE_STUDENT_STATUS };

    // Teachers only see the students in their own classes, same as /students.
    if (user.role === 'Teacher') {
      const teacher = await prisma.teacher.findUnique({ where: { id: user.id } });
      if (!teacher) return res.json({ today: startOfTodayISO(), days, birthdays: [] });
      const classes = await prisma.schoolClass.findMany({
        where: { teacher: { id: teacher.id } },
        select: { name: true, section: true }
      });
      if (classes.length === 0) return res.json({ today: startOfTodayISO(), days, birthdays: [] });
      where.OR = classes.map((c) => ({ class: c.name, section: c.section }));
    }

    if (classFilter && classFilter !== 'all') where.class = classFilter;
    if (sectionFilter && sectionFilter !== 'all') where.section = sectionFilter;

    const students = await prisma.student.findMany({
      where,
      select: {
        id: true,
        name: true,
        admissionNo: true,
        class: true,
        section: true,
        roll: true,
        gender: true,
        phone: true,
        guardianPhone: true,
        dob: true,
      },
    });

    const today = startOfDay(new Date());

    const birthdays = students
      .map((s) => {
        const upcoming = nextBirthday(s.dob as Date, today);
        const daysUntil = differenceInCalendarDays(upcoming, today);
        return {
          studentId: s.id,
          name: s.name,
          admissionNo: s.admissionNo,
          class: s.class,
          section: s.section,
          roll: s.roll,
          gender: s.gender,
          phone: s.phone,
          guardianPhone: s.guardianPhone,
          dob: s.dob,
          birthdayDate: upcoming.toISOString(),
          turningAge: upcoming.getFullYear() - (s.dob as Date).getFullYear(),
          daysUntil,
          isToday: daysUntil === 0,
          isUpcoming: daysUntil <= 7,
        };
      })
      .filter((b) => b.daysUntil >= 0 && b.daysUntil <= days)
      .sort((a, b) => a.daysUntil - b.daysUntil || a.roll - b.roll);

    res.json({ today: today.toISOString(), days, birthdays });
  } catch (error: any) {
    console.error('Error fetching student birthdays:', error);
    res.status(500).json({ error: 'Failed to fetch student birthdays' });
  }
});

/**
 * Next occurrence of a birth month/day on or after `today`.
 *
 * Feb 29 has no match in a common year, so it rolls forward to Mar 1 rather
 * than collapsing onto Feb 28.
 */
function nextBirthday(dob: Date, today: Date): Date {
  const thisYear = new Date(today.getFullYear(), dob.getMonth(), dob.getDate());
  if (differenceInCalendarDays(thisYear, today) < 0) {
    return new Date(today.getFullYear() + 1, dob.getMonth(), dob.getDate());
  }
  return thisYear;
}

function startOfTodayISO(): string {
  return startOfDay(new Date()).toISOString();
}

// Student Logins
// NOTE: these must stay ABOVE `app.get('/students/:id', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']))` below â€” Express matches
// routes in registration order, so a later `/students/:id` would swallow
// `/students/logins` and answer 404 "Student not found".
app.get('/students/logins', authMiddleware, checkRole(['Admin', 'Teacher']), async (_req: Request, res: Response) => {
  const logins = await prisma.studentLogin.findMany({
    include: { student: true },
    orderBy: { createdAt: 'desc' }
  });

  res.json(
    logins.map((l: any) => ({
      id: l.id,
      studentId: l.studentId,
      username: l.username,
      password: l.password,
      role: l.role,
      status: l.status,
      lastLogin: l.lastLogin,
    }))
  );
});

app.post('/students/logins', authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({
    studentId: z.string().min(1),
    username: z.string().min(3),
    password: z.string().min(4),
    role: z.string().optional(),
    status: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { studentId, username, password, role, status } = parsed.data;

  try {
    const login = await prisma.studentLogin.create({
      data: {
        studentId,
        username,
        password,
        role: role || 'Student',
        status: status || 'Active',
      },
    });
    res.status(201).json(login);
  } catch (e: any) {
    console.error('Create student login error:', e);
    res.status(500).json({ error: 'Failed to create student login', details: e.message });
  }
});

app.put('/students/logins/:id', authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    username: z.string().min(3).optional(),
    password: z.string().min(4).optional(),
    status: z.string().optional(),
    lastLogin: z.preprocess(
      (v) => (typeof v === 'string' ? new Date(v) : undefined),
      z.date().optional()
    ),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const login = await prisma.studentLogin.update({
      where: { id },
      data: parsed.data,
    });
    res.json(login);
  } catch (e: any) {
    console.error('Update student login error:', e);
    res.status(500).json({ error: 'Failed to update student login', details: e.message });
  }
});

app.delete('/students/logins/:id', authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.studentLogin.delete({ where: { id } });
    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Login record not found' });
    }
    console.error('Delete student login error:', error);
    res.status(500).json({ error: 'Failed to delete student login', details: error.message });
  }
});

app.get('/students/:id', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const student = await prisma.student.findUnique({
      where: { id },
      include: { guardian: true, login: true, parent: true }
    });
    if (!student) return res.status(404).json({ error: 'Student not found' });
    res.json(student);
  } catch (error) {
    console.error('Error fetching student:', error);
    res.status(500).json({ error: 'Failed to fetch student' });
  }
});

app.post('/students', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    admissionNo: z.string().optional(),
    class: z.string().min(1),
    section: z.string().optional(),
    roll: z.coerce.number().int().optional(),
    gender: z.string().optional(),
    bloodGroup: z.string().optional(),
    religion: z.string().optional(),
    banglaName: z.string().optional(),
    dob: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : undefined), z.date().optional()),
    phone: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().optional()
    ),
    email: z.string().email().optional().or(z.literal('')),
    nationality: z.string().optional(),
    medicalNote: z.string().optional(),
    additionalNote: z.string().optional(),
    birthCertNo: z.string().optional(),
    siblingsCount: z.coerce.number().int().optional(),
    guardianPhone: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().optional()
    ),
    guardianEmail: z.string().email().optional().or(z.literal('')),
    fatherName: z.string().optional(),
    motherName: z.string().optional(),
    address: z.string().optional(),
    academicYear: z.string().optional(),
    shift: z.string().optional(),
    admissionDate: z.preprocess(
      (v) => (typeof v === 'string' ? new Date(v) : undefined),
      z.date().optional()
    ),
    avatar: z.preprocess(
      (v) => (typeof v === 'string' && (v.trim() === '' || !v.startsWith('http') && !v.startsWith('data:image')) ? undefined : v),
      z.string().optional()
    ),
    status: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let { admissionNo } = parsed.data;
  if (!admissionNo) {
    const count = await prisma.student.count();
    const year = new Date().getFullYear();
    admissionNo = `ADM-${year}-${String(count + 1).padStart(4, '0')}`;
  }

  // Ensure uniqueness (simple retry logic or just hope for best? Better to check)
  // For now, let's assume it's unique enough or the DB will throw an error. 
  // If DB throws error, we should catch it.

  try {
    const data: any = {
      ...parsed.data,
      admissionNo: admissionNo!,
      section: parsed.data.section || '',
      gender: parsed.data.gender || 'Other',
      roll: parsed.data.roll || 0,
      admissionDate: parsed.data.admissionDate || new Date(),
      bloodGroup: parsed.data.bloodGroup || '',
      religion: parsed.data.religion || '',
      banglaName: parsed.data.banglaName || '',
      guardianPhone: parsed.data.guardianPhone || '',
      guardianEmail: parsed.data.guardianEmail || '',
      fatherName: parsed.data.fatherName || '',
      motherName: parsed.data.motherName || '',
      phone: parsed.data.phone || '',
      email: parsed.data.email || '',
      nationality: parsed.data.nationality || '',
      medicalNote: parsed.data.medicalNote || '',
      additionalNote: parsed.data.additionalNote || '',
      birthCertNo: parsed.data.birthCertNo || '',
      siblingsCount: parsed.data.siblingsCount ?? 0,
      address: parsed.data.address || '',
      academicYear: parsed.data.academicYear || '',
      shift: parsed.data.shift || '',
      avatar: parsed.data.avatar || '',
      status: parsed.data.status || 'Active'
    };
    const student = await prisma.student.create({ data });
    res.status(201).json(student);
  } catch (e: any) {
    if (e.code === 'P2002') {
      // Collision, try one more time with random suffix
      const suffix = Math.floor(Math.random() * 1000);
      const newAdm = `${admissionNo}-${suffix}`;
      const retryData: any = {
        ...parsed.data,
        admissionNo: newAdm,
        section: parsed.data.section || '',
        gender: parsed.data.gender || 'Other',
        roll: parsed.data.roll || 0,
        admissionDate: parsed.data.admissionDate || new Date(),
        bloodGroup: parsed.data.bloodGroup || '',
        religion: parsed.data.religion || '',
        banglaName: parsed.data.banglaName || '',
        guardianPhone: parsed.data.guardianPhone || '',
        guardianEmail: parsed.data.guardianEmail || '',
        fatherName: parsed.data.fatherName || '',
        motherName: parsed.data.motherName || '',
        phone: parsed.data.phone || '',
        email: parsed.data.email || '',
        nationality: parsed.data.nationality || '',
        medicalNote: parsed.data.medicalNote || '',
        additionalNote: parsed.data.additionalNote || '',
        birthCertNo: parsed.data.birthCertNo || '',
        siblingsCount: parsed.data.siblingsCount ?? 0,
        address: parsed.data.address || '',
        academicYear: parsed.data.academicYear || '',
        shift: parsed.data.shift || '',
        avatar: parsed.data.avatar || '',
        status: parsed.data.status || 'Active'
      };
      const student = await prisma.student.create({ data: retryData });
      return res.status(201).json(student);
    }
    throw e;
  }
});

app.put('/students/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    name: z.string().min(1).optional(),
    admissionNo: z.string().min(1).optional(),
    class: z.string().min(1).optional(),
    section: z.string().optional(),
    roll: z.coerce.number().int().optional(),
    gender: z.string().optional(),
    bloodGroup: z.string().optional().nullable(),
    religion: z.string().optional().nullable(),
    banglaName: z.string().optional().nullable(),
    dob: z.preprocess((v) => (typeof v === 'string' && v ? new Date(v) : v === null ? null : undefined), z.date().optional().nullable()),
    email: z.string().email().optional().nullable().or(z.literal('')),
    phone: z.string().optional().nullable(),
    nationality: z.string().optional().nullable(),
    medicalNote: z.string().optional().nullable(),
    additionalNote: z.string().optional().nullable(),
    birthCertNo: z.string().optional().nullable(),
    siblingsCount: z.coerce.number().int().optional().nullable(),
    guardianPhone: z.string().optional().nullable(),
    guardianEmail: z.string().email().optional().nullable().or(z.literal('')),
    fatherName: z.string().optional().nullable(),
    motherName: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    academicYear: z.string().optional().nullable(),
    shift: z.string().optional().nullable(),
    admissionDate: z.preprocess((v) => (typeof v === 'string' && v ? new Date(v) : v === null ? null : undefined), z.date().optional().nullable()),
    avatar: z.string().optional().nullable(),
    status: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.avatar === '') parsed.data.avatar = null;

  // Prisma rejects null for DateTime fields - remove them so the value is left unchanged.
  const data: any = { ...parsed.data };
  if (data.dob === null) delete data.dob;
  if (data.admissionDate === null) delete data.admissionDate;

  const student = await prisma.student.update({ where: { id }, data });
  res.json(student);
});

app.delete('/students/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.$transaction([
      prisma.attendance.deleteMany({ where: { studentId: id } }),
      prisma.result.deleteMany({ where: { studentId: id } }),
      prisma.studentFee.deleteMany({ where: { studentId: id } }),
      prisma.studentLogin.deleteMany({ where: { studentId: id } }),
      prisma.studentFeeAssignment.deleteMany({ where: { studentId: id } }),
      prisma.student.delete({ where: { id } }),
    ]);
    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Student not found' });
    }
    console.error('Delete student error:', error);
    res.status(500).json({ error: 'Failed to delete student', details: error.message });
  }
});

function academicYearRange(label?: string | null): { start: Date | null; end: Date | null } {
  if (!label) return { start: null, end: null };
  const match = label.match(/(\d{4})/);
  if (!match) return { start: null, end: null };
  const startYear = Number(match[1]);
  // July-to-June academic year convention (matches the promotion default)
  return { start: new Date(startYear, 6, 1), end: new Date(startYear + 1, 6, 1) };
}

app.post('/students/promote', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      promotions: z.array(z.object({
        studentId: z.string().min(1),
        action: z.enum(['promote', 'graduate', 'retain']),
        newClass: z.string().optional(),
        newSection: z.string().optional(),
        newAcademicYear: z.string().optional(),
      })).min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const promotions = parsed.data.promotions;

    // Non-graduate actions need a destination
    for (const p of promotions) {
      if (p.action !== 'graduate' && (!p.newClass || !p.newSection || !p.newAcademicYear)) {
        return res.status(400).json({ error: `${p.action} action requires newClass, newSection and newAcademicYear` });
      }
    }

    const students = await prisma.student.findMany({
      where: { id: { in: promotions.map(p => p.studentId) } },
      select: { id: true, class: true, section: true, roll: true, academicYear: true, status: true },
    });
    const studentMap = new Map(students.map(s => [s.id, s]));

    let skipped = 0;
    let promotedCount = 0;
    let graduatedCount = 0;
    let retainedCount = 0;
    const operations: any[] = [];

    const promoteItems: { student: any; newClass: string; newSection: string; newAcademicYear: string }[] = [];
    const graduateIds: string[] = [];
    const retainItems: { student: any; newAcademicYear: string }[] = [];

    for (const p of promotions) {
      const student = studentMap.get(p.studentId);
      if (!student) { skipped++; continue; }

      if (p.action === 'promote') {
        const alreadyThere =
          student.class === p.newClass &&
          student.section === p.newSection &&
          student.academicYear === p.newAcademicYear;
        if (student.status !== 'Active' || alreadyThere) { skipped++; continue; }
        promoteItems.push({ student, newClass: p.newClass!, newSection: p.newSection!, newAcademicYear: p.newAcademicYear! });
      } else if (p.action === 'graduate') {
        if (student.status !== 'Active') { skipped++; continue; }
        graduateIds.push(student.id);
      } else {
        if (student.status !== 'Active' || student.academicYear === p.newAcademicYear) { skipped++; continue; }
        retainItems.push({ student, newAcademicYear: p.newAcademicYear! });
      }
    }

    // Promote: re-assign rolls per destination class/section (excluding students being moved)
    const promoteGroups = new Map<string, typeof promoteItems>();
    for (const item of promoteItems) {
      const key = `${item.newClass}||${item.newSection}`;
      const group = promoteGroups.get(key) ?? [];
      group.push(item);
      promoteGroups.set(key, group);
    }
    for (const [key, group] of promoteGroups) {
      const [newClass, newSection] = key.split('||');
      const ids = group.map(g => g.student.id);
      const existing = await prisma.student.aggregate({
        where: { class: newClass, section: newSection, id: { notIn: ids } },
        _max: { roll: true },
      });
      let nextRoll = (existing._max.roll ?? 0) + 1;

      group.forEach((g, i) => {
        const { start, end } = academicYearRange(g.student.academicYear);
        operations.push(
          prisma.student.update({
            where: { id: g.student.id },
            data: { class: newClass, section: newSection, academicYear: g.newAcademicYear, roll: nextRoll + i },
          }),
          prisma.studentAcademicRecord.create({
            data: {
              studentId: g.student.id,
              academicYear: g.student.academicYear || '',
              class: g.student.class,
              section: g.student.section,
              roll: g.student.roll,
              status: 'Promoted',
              startDate: start,
              endDate: end,
            },
          })
        );
      });
    }
    promotedCount = promoteItems.length;

    // Graduate: mark status only, keep class/section/year so history stays browsable
    for (const g of students.filter(s => graduateIds.includes(s.id))) {
      const { start, end } = academicYearRange(g.academicYear);
      operations.push(
        prisma.student.update({ where: { id: g.id }, data: { status: 'Graduated' } }),
        prisma.studentAcademicRecord.create({
          data: {
            studentId: g.id,
            academicYear: g.academicYear || '',
            class: g.class,
            section: g.section,
            roll: g.roll,
            status: 'Graduated',
            startDate: start,
            endDate: end,
          },
        })
      );
    }
    graduatedCount = graduateIds.length;

    // Retain: keep class/section/roll, bump year
    for (const item of retainItems) {
      const { start, end } = academicYearRange(item.student.academicYear);
      operations.push(
        prisma.student.update({ where: { id: item.student.id }, data: { academicYear: item.newAcademicYear } }),
        prisma.studentAcademicRecord.create({
          data: {
            studentId: item.student.id,
            academicYear: item.student.academicYear || '',
            class: item.student.class,
            section: item.student.section,
            roll: item.student.roll,
            status: 'Retained',
            startDate: start,
            endDate: end,
          },
        })
      );
    }
    retainedCount = retainItems.length;

    if (operations.length > 0) {
      await prisma.$transaction(operations);
    }

    res.json({ success: true, promoted: promotedCount, graduated: graduatedCount, retained: retainedCount, skipped });
  } catch (error: any) {
    console.error('Promote students error:', error);
    res.status(500).json({ error: 'Failed to promote students', details: error.message });
  }
});

// Academic year history for a student (records + current enrollment)
app.get('/students/:id/history', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const student = await prisma.student.findUnique({
      where: { id },
      select: { id: true, name: true, admissionNo: true, class: true, section: true, roll: true, academicYear: true, status: true },
    });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const records = await prisma.studentAcademicRecord.findMany({
      where: { studentId: id },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ student, records });
  } catch (error: any) {
    console.error('Error fetching student history:', error);
    res.status(500).json({ error: 'Failed to fetch student history', details: error.message });
  }
});

// Attendance for a student within an academic year
app.get('/students/:id/attendance', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { academicYear } = req.query as any;
    const { start, end } = academicYearRange(academicYear);
    if (!start || !end) return res.status(400).json({ error: 'A valid academicYear is required' });

    const records = await prisma.attendance.findMany({
      where: { studentId: id, date: { gte: start, lt: end } },
      orderBy: { date: 'asc' },
    });
    res.json(records);
  } catch (error: any) {
    console.error('Error fetching student attendance:', error);
    res.status(500).json({ error: 'Failed to fetch student attendance', details: error.message });
  }
});

// Marks (results) for a student within an academic year
app.get('/students/:id/results', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { academicYear } = req.query as any;
    const where: any = { studentId: id };
    if (academicYear) where.exam = { academicYear };

    const results = await prisma.result.findMany({
      where,
      include: { exam: true },
      orderBy: { createdAt: 'desc' },
    });
    const subjectIds = [...new Set(results.map(r => r.subjectId))];
    const subjects = await prisma.subject.findMany({ where: { id: { in: subjectIds } } });
    res.json({ results, subjects });
  } catch (error: any) {
    console.error('Error fetching student results:', error);
    res.status(500).json({ error: 'Failed to fetch student results', details: error.message });
  }
});

// Fees/invoices for a student within an academic year
app.get('/students/:id/fees', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { academicYear } = req.query as any;
    const { start, end } = academicYearRange(academicYear);
    if (!start || !end) return res.status(400).json({ error: 'A valid academicYear is required' });

    const invoices = await prisma.invoice.findMany({
      where: {
        studentId: id,
        OR: [
          { createdAt: { gte: start, lt: end } },
          { dueDate: { gte: start, lt: end } },
        ],
      },
      include: { items: true, payments: true },
      orderBy: { createdAt: 'desc' },
    });

    const studentFees = await prisma.studentFee.findMany({
      where: { studentId: id, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ invoices, studentFees });
  } catch (error: any) {
    console.error('Error fetching student fees:', error);
    res.status(500).json({ error: 'Failed to fetch student fees', details: error.message });
  }
});

// Promotion archive: distinct academic years + roster per year
app.get('/promotions/archive', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { academicYear } = req.query as any;

    const recordYears = await prisma.studentAcademicRecord.findMany({ distinct: ['academicYear'], select: { academicYear: true } });
    const studentYears = await prisma.student.findMany({ distinct: ['academicYear'], select: { academicYear: true } });
    const years = Array.from(new Set([
      ...recordYears.map(r => r.academicYear),
      ...studentYears.map(s => s.academicYear),
    ])).filter(Boolean).sort().reverse();

    if (!academicYear) return res.json({ years, students: [] });

    const records = await prisma.studentAcademicRecord.findMany({
      where: { academicYear },
      include: {
        student: { select: { id: true, name: true, admissionNo: true, avatar: true, gender: true } },
      },
      orderBy: [{ class: 'asc' }, { section: 'asc' }, { roll: 'asc' }],
    });

    const current = await prisma.student.findMany({
      where: { academicYear },
      select: { id: true, name: true, admissionNo: true, avatar: true, gender: true, class: true, section: true, roll: true, status: true },
      orderBy: [{ class: 'asc' }, { section: 'asc' }, { roll: 'asc' }],
    });

    const mapped = records.map((r: any) => ({
      id: r.student.id,
      name: r.student.name,
      admissionNo: r.student.admissionNo,
      avatar: r.student.avatar,
      gender: r.student.gender,
      class: r.class,
      section: r.section || '',
      roll: r.roll,
      status: r.status,
    }));

    const recordKeys = new Set(records.map((r: any) => `${r.student.id}:${r.class}:${r.section || ''}`));
    const currentMapped = current
      .filter((s: any) => !recordKeys.has(`${s.id}:${s.class}:${s.section || ''}`))
      .map((s: any) => ({ ...s, status: 'Enrolled' }));

    res.json({ years, students: [...mapped, ...currentMapped] });
  } catch (error: any) {
    console.error('Error fetching promotion archive:', error);
    res.status(500).json({ error: 'Failed to fetch promotion archive', details: error.message });
  }
});

// Exam Types
app.get('/exam-types', authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  try {
    const types = await prisma.examType.findMany({ orderBy: { name: 'asc' } });
    res.json(types);
  } catch (error: any) {
    console.error('Error fetching exam types:', error);
    res.status(500).json({ error: 'Failed to fetch exam types', details: error.message });
  }
});

app.post('/exam-types', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({ name: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const type = await prisma.examType.create({ data: { name: parsed.data.name } });
    res.status(201).json(type);
  } catch (error: any) {
    console.error('Error creating exam type:', error);
    res.status(500).json({ error: 'Failed to create exam type', details: error.message });
  }
});

app.patch('/exam-types/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const schema = z.object({ name: z.string().min(1).max(100) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const type = await prisma.examType.update({ where: { id }, data: { name: parsed.data.name } });
    res.json(type);
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Exam type not found' });
    }
    console.error('Rename exam type error:', error);
    res.status(500).json({ error: 'Failed to rename exam type', details: error.message });
  }
});

app.delete('/exam-types/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    // Resolve exam IDs of this type up front so dependent rows can be cleared
    // in the same transaction. Exam type is referenced by Exam.typeId,
    // ExamSchedule.gradingTypeId, and GradingSystem.examTypeId; results and
    // publish/validation rows reference Exam.
    const examIds = (await prisma.exam.findMany({ where: { typeId: id }, select: { id: true } })).map((e) => e.id);
    await prisma.$transaction([
      // Null out per-subject gradingTypeId on schedules that reference this type
      prisma.examSchedule.updateMany({ where: { gradingTypeId: id }, data: { gradingTypeId: null } }),
      prisma.gradingSystem.deleteMany({ where: { examTypeId: id } }),
      prisma.result.deleteMany({ where: { examId: { in: examIds } } }),
      prisma.resultPublish.deleteMany({ where: { examId: { in: examIds } } }),
      prisma.resultValidationRun.deleteMany({ where: { examId: { in: examIds } } }),
      prisma.examSchedule.deleteMany({ where: { examId: { in: examIds } } }),
      prisma.exam.deleteMany({ where: { typeId: id } }),
      prisma.examType.delete({ where: { id } }),
    ]);
    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Exam type not found' });
    }
    if (error.code === 'P2003') {
      return res.status(409).json({ error: 'Cannot delete exam type: it is still referenced by schedules, exams, results, or grading rules. Remove those first.' });
    }
    console.error('Delete exam type error:', error);
    res.status(500).json({ error: 'Failed to delete exam type', details: error.message || String(error) });
  }
});

// Exams
app.get('/exams', authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const exams = await prisma.exam.findMany({
    include: { type: true },
    orderBy: { startDate: 'desc' }
  });
  res.json(exams);
});

app.post('/exams', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      name: z.string().trim().min(1, 'Exam name is required'),
      typeId: z.string().min(1, 'Exam type is required'),
      startDate: z.string().min(1, 'Start date is required'),
      endDate: z.string().min(1, 'End date is required'),
      academicYear: z.string().min(1, 'Academic year is required'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { name, typeId, startDate, endDate, academicYear } = parsed.data;
    // Validate/canonicalize the academic year so reports keyed on exact strings
    // don't break on typos. (#18)
    const canonicalYear = normalizeAcademicYear(academicYear);
    if (!canonicalYear) {
      return res.status(400).json({ error: `Invalid academicYear "${academicYear}". Use format like "2026-27" or "2026".` });
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime())) return res.status(400).json({ error: `Invalid start date "${startDate}".` });
    if (isNaN(end.getTime())) return res.status(400).json({ error: `Invalid end date "${endDate}".` });
    if (end < start) return res.status(400).json({ error: 'End date cannot be before the start date.' });

    const type = await prisma.examType.findUnique({ where: { id: typeId } });
    if (!type) return res.status(400).json({ error: 'Selected exam type no longer exists. Refresh and pick a valid type.' });

    const exam = await prisma.exam.create({
      data: { name, typeId, startDate: start, endDate: end, academicYear: canonicalYear },
      include: { type: true }
    });
    res.status(201).json(exam);
  } catch (error: any) {
    console.error('Error creating exam:', error);
    res.status(500).json({ error: 'Failed to create exam', details: error.message });
  }
});

// Edit an existing exam (name, type, academic year, date range).
app.put('/exams/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const schema = z.object({
      name: z.string().min(1).optional(),
      typeId: z.string().min(1).optional(),
      startDate: z.string().min(1).optional(),
      endDate: z.string().min(1).optional(),
      academicYear: z.string().min(1).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const existing = await prisma.exam.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Exam not found' });

    const { name, typeId, startDate, endDate, academicYear } = parsed.data;

    let canonicalYear: string = existing.academicYear;
    if (academicYear) {
      const normalized = normalizeAcademicYear(academicYear);
      if (!normalized) {
        return res.status(400).json({ error: `Invalid academicYear "${academicYear}". Use format like "2026-27" or "2026".` });
      }
      canonicalYear = normalized;
    }

    if (typeId) {
      const type = await prisma.examType.findUnique({ where: { id: typeId } });
      if (!type) return res.status(400).json({ error: 'Exam type not found' });
    }

    const nextStart = startDate ? new Date(startDate) : existing.startDate;
    const nextEnd = endDate ? new Date(endDate) : existing.endDate;
    if (nextEnd < nextStart) {
      return res.status(400).json({ error: 'End date cannot be before start date' });
    }

    const updated = await prisma.exam.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(typeId !== undefined ? { typeId } : {}),
        ...(startDate !== undefined ? { startDate: nextStart } : {}),
        ...(endDate !== undefined ? { endDate: nextEnd } : {}),
        ...(academicYear !== undefined ? { academicYear: canonicalYear } : {}),
      },
      include: { type: true }
    });
    res.json(updated);
  } catch (error: any) {
    console.error('Error updating exam:', error);
    res.status(500).json({ error: 'Failed to update exam', details: error.message });
  }
});

// Dependent-record counts for an exam, so the client can warn before deleting.
app.get('/exams/:id/dependents', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const exam = await prisma.exam.findUnique({ where: { id } });
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    const [schedules, results, publish, validationRuns, attendances] = await Promise.all([
      prisma.examSchedule.count({ where: { examId: id } }),
      prisma.result.count({ where: { examId: id } }),
      prisma.resultPublish.count({ where: { examId: id } }),
      prisma.resultValidationRun.count({ where: { examId: id } }),
      prisma.examAttendance.count({ where: { examId: id } }),
    ]);

    const dependents: Record<string, number> = {};
    if (schedules > 0) dependents.schedules = schedules;
    if (results > 0) dependents.results = results;
    if (publish > 0) dependents.resultsPublished = publish;
    if (validationRuns > 0) dependents.validationRuns = validationRuns;
    if (attendances > 0) dependents.examAttendance = attendances;

    res.json({ id, dependents });
  } catch (error: any) {
    console.error('Error fetching exam dependents:', error);
    res.status(500).json({ error: 'Failed to load related records', details: error.message });
  }
});

// Delete an exam and everything attached to it. Related records are removed in
// the same transaction (most FKs here are ON DELETE RESTRICT, so Prisma will not
// cascade them on its own). The client confirms against /exams/:id/dependents.
app.delete('/exams/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const exam = await prisma.exam.findUnique({ where: { id } });
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    const [schedules, results, publish, validationRuns, attendances] = await Promise.all([
      prisma.examSchedule.count({ where: { examId: id } }),
      prisma.result.count({ where: { examId: id } }),
      prisma.resultPublish.count({ where: { examId: id } }),
      prisma.resultValidationRun.count({ where: { examId: id } }),
      prisma.examAttendance.count({ where: { examId: id } }),
    ]);

    const blockers: Record<string, number> = {};
    if (schedules > 0) blockers.schedules = schedules;
    if (results > 0) blockers.results = results;
    if (publish > 0) blockers.resultsPublished = publish;
    if (validationRuns > 0) blockers.validationRuns = validationRuns;
    if (attendances > 0) blockers.examAttendance = attendances;

    const hasBlockers = Object.keys(blockers).length > 0;
    if (hasBlockers) {
      // Order matters: children first, since most FKs are ON DELETE RESTRICT.
      await prisma.$transaction([
        prisma.resultPublish.deleteMany({ where: { examId: id } }),
        prisma.resultValidationRun.deleteMany({ where: { examId: id } }),
        prisma.result.deleteMany({ where: { examId: id } }),
        prisma.examAttendance.deleteMany({ where: { examId: id } }),
        prisma.examSchedule.deleteMany({ where: { examId: id } }),
      ]);
    }

    await prisma.exam.delete({ where: { id } });
    res.json({ success: true, id, deletedDependents: hasBlockers ? blockers : {} });
  } catch (error: any) {
    console.error('Error deleting exam:', error);
    res.status(500).json({ error: 'Failed to delete exam', details: error.message });
  }
});

// Admin-configurable exam weight (used in Weighted Academic Score ranking).
app.post('/exams/:id/weight', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    let { weight } = req.body || {};
    weight = Number(weight);
    if (isNaN(weight) || weight < 0) return res.status(400).json({ error: 'Invalid weight. Must be a number >= 0' });
    const updated = await prisma.exam.update({ where: { id }, data: { weight }, select: { id: true, name: true, weight: true } });
    res.json(updated);
  } catch (error: any) {
    console.error('Error updating exam weight:', error);
    res.status(500).json({ error: 'Failed to update exam weight', details: error.message });
  }
});

// Exam Attendance - Get classes with active schedules for an exam
app.get('/exams/:examId/attendance/classes', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;

    // Get exam schedules for this exam grouped by class
    const schedules = await prisma.examSchedule.findMany({
      where: { examId },
      include: { 
        class: true,
        subject: true,
      },
    });

    // Get unique classes from schedules with their sections
    const classSectionsMap = new Map<string, Set<string>>();
    schedules.forEach(schedule => {
      if (schedule.classId) {
        const className = schedule.class?.name || schedule.classId;
        if (!classSectionsMap.has(className)) {
          classSectionsMap.set(className, new Set());
        }
        classSectionsMap.get(className)!.add(schedule.classId);
      }
    });

    // Get students count per class/section from schedules
    const classData = await Promise.all(
      Array.from(classSectionsMap.entries()).map(async ([className, classIds]) => {
        const sections = Array.from(classIds);
        const students = await prisma.student.findMany({
          where: { class: className, status: ACTIVE_STUDENT_STATUS },
          select: { section: true },
          distinct: ['section'],
        });
        return {
          name: className,
          sections: students.map(s => s.section),
        };
      })
    );

    res.json(classData);
  } catch (error: any) {
    console.error('Error fetching exam schedule classes:', error);
    res.status(500).json({ error: 'Failed to fetch classes', details: error.message });
  }
});

// Exam Attendance - Get attendance for an exam (with filters)
app.get('/exams/:examId/attendance', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;
    const { subjectId, class: className, section, date } = req.query as any;

    // Get exam schedules for this exam (to know which subjects/dates)
    const schedules = await prisma.examSchedule.findMany({
      where: { 
        examId,
        ...(className && { class: { name: className } }),
      },
      include: { subject: true },
    });

    // Get unique dates from schedules
    const examDates = [...new Set(schedules.map(s => s.date.toISOString().split('T')[0]))];

    // When a date is selected, scope the subjects/dropdown to only those
    // scheduled on that date (prevents picking a subject from another day).
    // Compare using local calendar days, consistent with localDayKey().
    const dateKey = localDayKey(new Date(date));
    const effectiveSchedules = date
      ? schedules.filter(s => localDayKey(s.date) === dateKey)
      : schedules;

    // Get existing attendance records
    const whereClause: any = { examId };
    if (subjectId) whereClause.subjectId = subjectId;
    if (date) whereClause.date = new Date(date);

    const attendances = await prisma.examAttendance.findMany({
      where: whereClause,
      include: { student: true, subject: true },
    });

    // Get students for the selected class/section (on-roll only)
    let students: any[] = [];
    if (className && section) {
      students = await prisma.student.findMany({
        where: { class: className, section, status: ACTIVE_STUDENT_STATUS },
        orderBy: { roll: 'asc' },
      });
    }

    // Build response with all students and their attendance status
    const studentAttendance = students.map(student => {
      const records = attendances.filter(a => a.studentId === student.id);
      const attendanceBySubject: Record<string, any> = {};

      effectiveSchedules.forEach(schedule => {
        const record = records.find(r => r.subjectId === schedule.subjectId && 
          r.date.toISOString().split('T')[0] === schedule.date.toISOString().split('T')[0]);
        attendanceBySubject[schedule.subjectId] = {
          subjectId: schedule.subjectId,
          subjectName: schedule.subject.name,
          date: schedule.date.toISOString().split('T')[0],
          status: record?.status || null,
          reason: record?.reason || null,
          notes: record?.notes || null,
        };
      });

      return {
        studentId: student.id,
        studentName: student.name,
        roll: student.roll,
        attendances: attendanceBySubject,
      };
    });

    res.json({
      examId,
      // Dedupe by subjectId: the same grade can have multiple sections with
      // identical timetables, which would otherwise yield duplicate dropdown
      // options with colliding keys.
      subjects: [...new Map(effectiveSchedules.map(s => [s.subjectId, {
        id: s.subjectId,
        name: s.subject.name,
        date: localDayKey(s.date),
        startTime: s.startTime,
        endTime: s.endTime,
      }])).values()],
      dates: examDates,
      students: studentAttendance,
    });
  } catch (error: any) {
    console.error('Error fetching exam attendance:', error);
    res.status(500).json({ error: 'Failed to fetch exam attendance', details: error.message });
  }
});

// Exam Attendance - Save attendance records
app.post('/exams/:examId/attendance/save', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;
    const schema = z.array(z.object({
      studentId: z.string().min(1),
      subjectId: z.string().min(1),
      date: z.string().min(1),
      status: z.enum(['PRESENT', 'ABSENT', 'LATE', 'EXCUSED']),
      reason: z.string().optional(),
      notes: z.string().optional(),
    }));
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const records = parsed.data;

    // Only on-roll students may be marked. Inactive/graduated students are
    // dropped here so they cannot be recorded as absent for the exam.
    const eligibleStudents = await prisma.student.findMany({
      where: { id: { in: [...new Set(records.map((r) => r.studentId))] }, status: ACTIVE_STUDENT_STATUS },
      select: { id: true },
    });
    const eligibleIds = new Set(eligibleStudents.map((s) => s.id));
    const activeRecords = records.filter((r) => eligibleIds.has(r.studentId));
    const rejectedInactive = records
      .filter((r) => !eligibleIds.has(r.studentId))
      .map((r) => ({ studentId: r.studentId, subjectId: r.subjectId, date: r.date }));
    if (activeRecords.length === 0) {
      return res.status(400).json({
        error: 'No active students in the submitted records. Attendance cannot be recorded for inactive or graduated students.',
        invalid: rejectedInactive,
      });
    }

    // Validate that every (subjectId, date) being marked is actually scheduled
    // for this exam. This prevents attendance being saved for subjects/days
    // that aren't part of the exam timetable. (#13)
    const schedules = await prisma.examSchedule.findMany({
      where: { examId },
      select: { subjectId: true, date: true },
    });
    const scheduled = new Set<string>();
    for (const s of schedules) {
      scheduled.add(`${s.subjectId}::${localDayKey(new Date(s.date))}`);
    }
    const invalid = activeRecords.filter(
      (r) => !scheduled.has(`${r.subjectId}::${localDayKey(new Date(r.date))}`)
    );
    if (invalid.length > 0) {
      return res.status(400).json({
        error: 'Attendance can only be saved for subjects/dates that are scheduled for this exam',
        invalid: invalid.map((r) => ({ studentId: r.studentId, subjectId: r.subjectId, date: r.date })),
      });
    }

    // Attendance may be recorded for any date that belongs to this exam's
    // timetable (past or future), so missed days can be filled in and later
    // corrections are always possible.

    // Use upsert for each record, and keep the matching Result row in sync so
    // absence is visible as ABSENT in results, tabulation and analytics even
    // when no marks were ever entered for that subject.
    await prisma.$transaction(async (tx) => {
      for (const record of activeRecords) {
        const day = new Date(`${localDayKey(new Date(record.date))}T00:00:00.000Z`);
        await tx.examAttendance.upsert({
          where: {
            examId_studentId_subjectId_date: {
              examId,
              studentId: record.studentId,
              subjectId: record.subjectId,
              date: day,
            },
          },
          create: {
            examId,
            studentId: record.studentId,
            subjectId: record.subjectId,
            date: day,
            status: record.status,
            reason: record.reason,
            notes: record.notes,
          },
          update: {
            status: record.status,
            reason: record.reason,
            notes: record.notes,
          },
        });

        if (record.status === 'ABSENT') {
          await tx.result.upsert({
            where: {
              studentId_examId_subjectId: {
                studentId: record.studentId,
                examId,
                subjectId: record.subjectId,
              },
            },
            update: {
              isAbsent: true,
              written: 0,
              mcq: 0,
              practical: 0,
              totalMarks: 0,
              grade: 'ABSENT',
              gp: 0,
            },
            create: {
              studentId: record.studentId,
              examId,
              subjectId: record.subjectId,
              isAbsent: true,
              written: 0,
              mcq: 0,
              practical: 0,
              totalMarks: 0,
              grade: 'ABSENT',
              gp: 0,
            },
          });
        }
      }
    });

    res.json({ success: true, count: activeRecords.length, skippedInactive: rejectedInactive.length });
  } catch (error: any) {
    console.error('Error saving exam attendance:', error);
    res.status(500).json({ error: 'Failed to save exam attendance', details: error.message });
  }
});

// Exam Attendance - Get report/summary
app.get('/exams/:examId/attendance/report', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;
    const { class: className, section } = req.query as any;

    // Build student filter. Restricted to on-roll students so inactive /
    // graduated students never show up in the exam attendance report or drag
    // the overall attendance rate down.
    const studentFilter: any = { status: ACTIVE_STUDENT_STATUS };
    if (className) studentFilter.class = className;
    if (section) studentFilter.section = section;

    // Get all attendance for this exam
    const attendances = await prisma.examAttendance.findMany({
      where: {
        examId,
        student: studentFilter,
      },
      include: { student: true, subject: true },
    });

    // Get all students
    const students = await prisma.student.findMany({
      where: studentFilter,
      orderBy: { roll: 'asc' },
    });

    // Calculate stats per student
    const studentStats = students.map(student => {
      const records = attendances.filter(a => a.studentId === student.id);
      const present = records.filter(r => r.status === 'PRESENT').length;
      const absent = records.filter(r => r.status === 'ABSENT').length;
      const late = records.filter(r => r.status === 'LATE').length;
      const excused = records.filter(r => r.status === 'EXCUSED').length;
      const total = records.length || 1;

      return {
        studentId: student.id,
        studentName: student.name,
        roll: student.roll,
        class: student.class,
        section: student.section,
        present,
        absent,
        late,
        excused,
        attendanceRate: total > 0 ? Math.round(((present + late) / total) * 100) : 0,
      };
    });

    // Overall stats
    const totalRecords = attendances.length;
    const overallPresent = attendances.filter(a => a.status === 'PRESENT').length;
    const overallAbsent = attendances.filter(a => a.status === 'ABSENT').length;
    const overallLate = attendances.filter(a => a.status === 'LATE').length;
    const overallExcused = attendances.filter(a => a.status === 'EXCUSED').length;

    res.json({
      examId,
      overall: {
        total: totalRecords,
        present: overallPresent,
        absent: overallAbsent,
        late: overallLate,
        excused: overallExcused,
        attendanceRate: totalRecords > 0 ? Math.round(((overallPresent + overallLate) / totalRecords) * 100) : 0,
      },
      students: studentStats,
    });
  } catch (error: any) {
    console.error('Error generating exam attendance report:', error);
    res.status(500).json({ error: 'Failed to generate report', details: error.message });
  }
});

// Build a FROZEN grading snapshot (bands + template reference) for a schedule at
// scheduling time. Later edits to the grading template never affect schedules
// that already carry this snapshot (non-retroactivity safeguard). Returns null
// when there is no usable grading template to snapshot.
function parseGradingSnapshot(value: any): any {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
}

async function buildGradingSnapshot(
  gradingTypeId: string | null | undefined,
  fullMarks: number | null | undefined,
  db: Prisma.TransactionClient | PrismaClient = prisma,
  snapshotDate: Date = new Date()
): Promise<any> {
  const tplId = gradingTypeId;
  if (!tplId) return null;
  const [bands, examType] = await Promise.all([
    db.gradingSystem.findMany({
      where: { examTypeId: tplId },
      orderBy: { minPercent: 'asc' },
      select: { grade: true, minPercent: true, maxPercent: true, gp: true, status: true, totalFull: true },
    }),
    db.examType.findUnique({ where: { id: tplId }, select: { name: true } }),
  ]);
  if (!bands || bands.length === 0) return null;
  // The template's own totalFull defines the reference scale for its mark-based
  // bands (e.g. 50 for the "50 Marks" template). It is authoritative over any
  // client-supplied fullMarks so marks-based scales snapshot correctly.
  const templateTotalFull = bands.find(b => (b as any).totalFull && (b as any).totalFull > 0)?.totalFull;
  return {
    templateId: tplId,
    templateName: examType?.name || 'Grading Template',
    snapshotDate: snapshotDate.toISOString(),
    totalFull: (templateTotalFull && templateTotalFull > 0) ? templateTotalFull : (fullMarks && fullMarks > 0 ? fullMarks : 100),
    bands,
  };
}

// Return the authoritative full-marks scale for a resolved grading template
// (the template's own totalFull), or null when none resolves.
async function fetchTemplateTotalFull(
  gradingTypeId: string | null | undefined,
  db: Prisma.TransactionClient | PrismaClient = prisma
): Promise<number | null> {
  const tplId = gradingTypeId;
  if (!tplId) return null;
  const row = await db.gradingSystem.findFirst({
    where: { examTypeId: tplId, totalFull: { gt: 0 } },
    select: { totalFull: true },
    orderBy: { totalFull: 'desc' },
  });
  return row && (row.totalFull ?? 0) > 0 ? row.totalFull : null;
}

// Resolve which grading template id a schedule should use (explicit override ->
// exam type). Used by both snapshot capture and grade calculation.
function resolveGradingTypeId(
  scheduleGradingTypeId: string | null | undefined,
  examTypeId: string | null | undefined
): string | null {
  return scheduleGradingTypeId || examTypeId || null;
}

// Percentage-style templates (totalFull >= 100) rebase any schedule scale and
// grade correctly (a 40/50 paper is a 40/50 = 80% paper). Mark-based templates
// (e.g. a 50-mark template whose bands are expressed as marks out of 50) only
// line up when the schedule's full marks equal the template scale — otherwise
// 40/50 is compared as 40/100 and the grade is one band too low. Used by result
// validation and the publish gate so a new exam cannot be graded on the wrong
// denominator.
type ScheduleScaleMismatch = {
  scheduleId: string;
  subject: string;
  classLabel: string | null;
  fullMarks: number;
  expected: number;
};
async function findScheduleScaleMismatches(examId: string): Promise<ScheduleScaleMismatch[]> {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { typeId: true } });
  if (!exam) return [];
  const schedules = await prisma.examSchedule.findMany({
    where: { examId },
    include: { subject: true, class: true },
  });
  const templateFullCache = new Map<string, number | null>();
  const mismatches: ScheduleScaleMismatch[] = [];
  for (const s of schedules) {
    const tplId = resolveGradingTypeId(s.gradingTypeId, exam.typeId);
    if (!tplId) continue;
    if (!templateFullCache.has(tplId)) {
      templateFullCache.set(tplId, await fetchTemplateTotalFull(tplId));
    }
    let expected = templateFullCache.get(tplId) ?? null;
    // A frozen snapshot is authoritative for schedules already created.
    const snapshot = parseGradingSnapshot(s.gradingSnapshot);
    if (snapshot && Number(snapshot.totalFull) > 0) expected = Number(snapshot.totalFull);
    if (!expected || expected >= 100) continue; // percentage-style template: scale-agnostic
    const full = Number(s.fullMarks) || 0;
    if (full > 0 && full !== expected) {
      mismatches.push({
        scheduleId: s.id,
        subject: s.subject?.name || s.subjectId,
        classLabel: s.class ? `${s.class.name}${s.class.section ? `-${s.class.section}` : ''}` : null,
        fullMarks: full,
        expected,
      });
    }
  }
  return mismatches;
}

// Results
app.get('/results', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const { examId, subjectId, studentIds } = req.query as any;
  if (!examId) return res.status(400).json({ error: 'examId is required' });

  const where: any = { examId };
  if (subjectId) where.subjectId = subjectId;
  if (studentIds) {
    where.studentId = { in: studentIds.split(',') };
  }

  // Merge exam-attendance absence so absent subjects render as ABSENT/ABS
  // instead of zero marks everywhere results are consumed.
  const report = await buildExamReport(examId);
  let results = report.results;
  if (subjectId) results = results.filter((r: any) => r.subjectId === subjectId);
  if (studentIds) {
    const ids = studentIds.split(',');
    results = results.filter((r: any) => ids.includes(r.studentId));
  }
  res.json(results);
});

app.post('/results/bulk', authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({
    examId: z.string().min(1),
    subjectId: z.string().min(1),
    marks: z.array(z.object({
      studentId: z.string().min(1),
      written: z.number().min(0).default(0),
      mcq: z.number().min(0).default(0),
      practical: z.number().min(0).default(0),
    })).min(1)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { examId, subjectId, marks } = parsed.data;

  // Fetch Grading System, Exam Schedules, Exam details, and Students
  const [exam, schedules, existingResults] = await Promise.all([
    prisma.exam.findUnique({ where: { id: examId } }),
    prisma.examSchedule.findMany({ where: { examId, subjectId }, include: { class: true } }),
    prisma.result.findMany({
      where: { examId, subjectId }
    })
  ]);
  const studentIdsInScope = [...new Set([...marks.map(m => m.studentId), ...existingResults.map(r => r.studentId)])];
  const students = await prisma.student.findMany({
    where: { id: { in: studentIdsInScope } },
    select: { id: true, class: true, section: true }
  });

  if (!exam) return res.status(404).json({ error: 'Exam not found' });

  // Check if exam is published (prevent editing)
  if (exam.status === 'Published') {
    return res.status(403).json({
      error: 'Cannot edit marks for published results',
      message: 'Please unpublish the exam first to make corrections',
      examStatus: exam.status
    });
  }

  // Fetch all grading systems for per-subject grading support (gradingTypeId per ExamSchedule)
  const allGrading = await prisma.gradingSystem.findMany({ orderBy: { minPercent: 'desc' } });
  const gradingByType = new Map<string, typeof allGrading>();
  for (const g of allGrading) {
    const key = g.examTypeId ?? '__template__';
    if (!gradingByType.has(key)) gradingByType.set(key, []);
    gradingByType.get(key)!.push(g);
  }
  const defaultGrading = gradingByType.get(exam.typeId ?? '') || [];
  const grading = defaultGrading; // keep for backwards compat

  const studentMap = new Map(students.map(s => [s.id, s]));

  // STRICT COMPONENT VALIDATION - Check each student's marks against schedule configuration
  for (const m of marks) {
    const student = studentMap.get(m.studentId);
    const studentClass = student?.class;
    const studentSection = student?.section;
    const schedule = schedules.find(s => s.class?.name === studentClass && s.class?.section === studentSection && s.subjectId === subjectId)
      || schedules.find(s => !s.class && s.subjectId === subjectId);
    
    if (!schedule) {
      return res.status(400).json({
        error: `No schedule found for student ${m.studentId} (class: ${studentClass}${studentSection ? ` - ${studentSection}` : ''})`
      });
    }
    
    const { writtenFullMarks: sW, mcqFullMarks: sM, practicalFullMarks: sP } = schedule;
    // Resolve component full marks. Prefer the schedule's own snapshot, but fall
    // back to the grading template referenced by the schedule's gradingTypeId
    // (or the exam type) when the schedule has no component split stored.
    const gradingForSched = gradingByType.get(schedule.gradingTypeId || exam.typeId) || defaultGrading;
    const tpl = gradingForSched[0] as any;
    const writtenFullMarks = (sW || 0) > 0 ? sW : (tpl?.writtenFull ?? 0);
    const mcqFullMarks = (sM || 0) > 0 ? sM : (tpl?.mcqFull ?? 0);
    const practicalFullMarks = (sP || 0) > 0 ? sP : (tpl?.practicalFull ?? 0);
    const effectiveFullMarks = (schedule.fullMarks || 0) > 0
      ? schedule.fullMarks!
      : ((tpl?.totalFull ?? 0) || writtenFullMarks + mcqFullMarks + practicalFullMarks || 100);
    
    // Check written marks
    if ((writtenFullMarks || 0) === 0 && m.written !== 0) {
      return res.status(400).json({
        error: `Written marks must be 0 (component disabled)`,
        studentId: m.studentId
      });
    }
    if (m.written > (writtenFullMarks || 0)) {
      return res.status(400).json({
        error: `Written marks (${m.written}) exceed maximum (${writtenFullMarks})`,
        studentId: m.studentId
      });
    }
    
    // Check MCQ marks
    if ((mcqFullMarks || 0) === 0 && m.mcq !== 0) {
      return res.status(400).json({
        error: `MCQ marks must be 0 (component disabled)`,
        studentId: m.studentId
      });
    }
    if (m.mcq > (mcqFullMarks || 0)) {
      return res.status(400).json({
        error: `MCQ marks (${m.mcq}) exceed maximum (${mcqFullMarks})`,
        studentId: m.studentId
      });
    }
    
    // Check Practical marks
    if ((practicalFullMarks || 0) === 0 && m.practical !== 0) {
      return res.status(400).json({
        error: `Practical marks must be 0 (component disabled)`,
        studentId: m.studentId
      });
    }
    if (m.practical > (practicalFullMarks || 0)) {
      return res.status(400).json({
        error: `Practical marks (${m.practical}) exceed maximum (${practicalFullMarks})`,
        studentId: m.studentId
      });
    }
    
    // Check absence
    const attendance = await prisma.examAttendance.findFirst({
      where: { examId, studentId: m.studentId, subjectId }
    });
    
    if (attendance && attendance.status === 'ABSENT') {
      return res.status(400).json({
        error: `Cannot enter marks for absent student`,
        studentId: m.studentId,
      });
    }
    
    // Validate total
    const totalMarks = m.written + m.mcq + m.practical;
    if (totalMarks > effectiveFullMarks) {
      return res.status(400).json({
        error: `Total marks (${totalMarks}) exceed full marks (${effectiveFullMarks})`,
        studentId: m.studentId
      });
    }
  }

  // Default pass config (when schedule has no override) â€” used as fallback for template config
  const passConfig = defaultGrading.length > 0 ? defaultGrading[0] : null;

  const classKey = (cls?: string | null, section?: string | null) => `${cls || ''}||${section || ''}`;

  // Map class+section -> full marks for this subject.
  const fullMarksBySection = new Map<string, number>();
  const globalFullMarks = new Map<string, number>();
  for (const s of schedules) {
    if (s.class) {
      fullMarksBySection.set(classKey(s.class.name, s.class.section), s.fullMarks ?? 100);
    } else if (!globalFullMarks.has(s.subjectId)) {
      globalFullMarks.set(s.subjectId, s.fullMarks ?? 100);
    }
  }
  const defaultFullMarks = schedules.length > 0
    ? Math.max(...schedules.map(s => s.fullMarks ?? 100), 0)
    : 100;
  const fullMarksForStudent = (student?: { class: string; section: string }) =>
    (student ? fullMarksBySection.get(classKey(student.class, student.section)) : undefined)
      ?? globalFullMarks.get(subjectId)
      ?? defaultFullMarks;

  const passFor = (full: number, explicit?: number | null) => {
    const max = Math.max(0, Number(full) || 0);
    const configured = Number(explicit) || 0;
    return configured > 0 && configured <= max ? configured : Math.min(max, Math.round(max * 0.33));
  };

  // Precompute per (class, section) highest marks AFTER this batch = max of existing
  // results for that group plus this batch's new totals. (#7)
  const existingByClass = new Map<string, number[]>();
  const classOfStudent = (id: string) => {
    const st = studentMap.get(id);
    return st ? classKey(st.class, st.section) : undefined;
  };
  for (const r of existingResults) {
    const c = classOfStudent(r.studentId);
    if (!c) continue;
    if (!existingByClass.has(c)) existingByClass.set(c, []);
    existingByClass.get(c)!.push(r.totalMarks);
  }

  const involvedClassKeys = new Set<string>([
    ...existingByClass.keys(),
    ...students.map(s => classKey(s.class, s.section)),
  ]);
  const classStudentIdsByKey = new Map<string, string[]>();
  if (involvedClassKeys.size > 0) {
    const classStudents = await prisma.student.findMany({
      where: {
        OR: [...involvedClassKeys].map(key => {
          const [cls, section] = key.split('||');
          return { class: cls, section };
        }),
      },
      select: { id: true, class: true, section: true },
    });
    for (const st of classStudents) {
      const key = classKey(st.class, st.section);
      if (!classStudentIdsByKey.has(key)) classStudentIdsByKey.set(key, []);
      classStudentIdsByKey.get(key)!.push(st.id);
    }
  }

  // Build the highest marks per class, then update all results in ONE transaction
  // together with the upserts so both stay consistent even on failure. (#16)
  const result = await prisma.$transaction(async (tx) => {
    const classHighest = new Map<string, number>();
    // First upsert every mark and track per-class best from the batch.
    for (const m of marks) {
      const student = studentMap.get(m.studentId);
      const studentClass = student?.class;
      const studentSection = student?.section;
      const studentClassKey = classKey(studentClass, studentSection);
      const fullMarks = fullMarksForStudent(student);
      const totalMarks = m.written + m.mcq + m.practical;

      // Per-subject grading: use schedule's gradingTypeId if set, otherwise exam's type
      const scheduleForStudent = (schedules.find(s => s.class?.name === studentClass && s.class?.section === studentSection && s.subjectId === subjectId)
        || schedules.find(s => !s.class && s.subjectId === subjectId)) as any;
      const gradingTypeIdForThis = resolveGradingTypeId(scheduleForStudent?.gradingTypeId, exam.typeId);
      const gradingForThis = gradingByType.get(gradingTypeIdForThis || '') || defaultGrading;

      // Snapshot-first: if this schedule carries a frozen grading snapshot, use its
      // bands so later template edits never change already-scheduled exams. Fall
      // back to the live GradingSystem rows for schedules created before snapshots.
      let gradingBandsForThis = gradingForThis;
      // Reference full marks baked into the snapshot. Band bounds are stored as
      // marks relative to this reference; we rebase them to percentages below so
      // both marks-based (50-scale) and percentage-based (100-scale) templates
      // grade consistently (e.g. CT A+ [40,50] out of 50 -> 80%-100%).
      let snapTotalFull = 0;
      if (scheduleForStudent?.gradingSnapshot) {
        const snap = parseGradingSnapshot(scheduleForStudent.gradingSnapshot);
        if (snap?.bands && Array.isArray(snap.bands) && snap.bands.length > 0) {
          gradingBandsForThis = snap.bands;
          if (typeof snap.totalFull === 'number' && snap.totalFull > 0) {
            snapTotalFull = snap.totalFull;
          }
        }
      }
      const tplCfg = (gradingForThis[0] || passConfig) as any;
      const wFull = (scheduleForStudent?.writtenFullMarks ?? 0) > 0 ? scheduleForStudent.writtenFullMarks : (tplCfg?.writtenFull ?? 0);
      const mFull = (scheduleForStudent?.mcqFullMarks ?? 0) > 0 ? scheduleForStudent.mcqFullMarks : (tplCfg?.mcqFull ?? 0);
      const pFull = (scheduleForStudent?.practicalFullMarks ?? 0) > 0 ? scheduleForStudent.practicalFullMarks : (tplCfg?.practicalFull ?? 0);
      const effFull = (scheduleForStudent?.fullMarks ?? 0) > 0 ? scheduleForStudent.fullMarks : ((tplCfg?.totalFull ?? 0) || ((wFull || 0) + (mFull || 0) + (pFull || 0)));

      const wPass = passFor(wFull, scheduleForStudent?.writtenPassMarks);
      const mPass = passFor(mFull, scheduleForStudent?.mcqPassMarks);
      const pPass = passFor(pFull, scheduleForStudent?.practicalPassMarks);
      const tPass = passFor(effFull, scheduleForStudent?.passMarks);

      const writtenMandatory = (wFull || 0) > 0 && wPass > 0;
      const mcqMandatory = (mFull || 0) > 0 && mPass > 0;
      const practicalMandatory = (pFull || 0) > 0 && pPass > 0;

      let isFail = false;
      if (writtenMandatory && m.written < wPass) isFail = true;
      if (mcqMandatory && m.mcq < mPass) isFail = true;
      if (practicalMandatory && m.practical < pPass) isFail = true;
      if (totalMarks < tPass) isFail = true;

      // Zero-division guard. (#14)
      const percent = effFull > 0 ? (totalMarks / effFull) * 100 : 0;

      let gradeInfo;
      if (isFail) {
        gradeInfo = gradingBandsForThis.find((g: any) => String(g.status).toUpperCase() === 'FAIL') || { grade: 'F', gp: 0 };
      } else {
        // Match percentage. Band bounds are stored as marks relative to a
        // reference full (snapshot's totalFull for frozen data, the template's
        // totalFull for live grading). Rebase each bound to a percentage so both
        // marks-based (50-scale, e.g. CT A+ [40,50] -> 80%-100%) and
        // percentage-based (100-scale, e.g. Semester A+ [80,100] -> 80%-100%)
        // templates grade identically. Min is inclusive. We pick the highest band
        // whose rebased min <= the student's percentage; this is robust at exact
        // band boundaries (e.g. marks-based A [35,39] vs A+ [40,50] out of 50: a
        // mark of 39 = 78% belongs in A, 40 = 80% in A+) and avoids the gaps that
        // an exclusive-max rule would introduce on integer marks scales.
        const bandRefFull = snapTotalFull || ((tplCfg as any)?.totalFull ?? 0) || 100;
        // Derive the reference scale from the bands themselves: the highest maxPercent
        // in the bands equals the total full marks those bands were designed for.
        // This is more reliable than bandRefFull which may come from the exam/schedule
        // and could mismatch the bands' own scale (e.g. 50-mark CT bands used for a
        // 100-mark exam).
        const bandMax = Math.max(...gradingBandsForThis.map((g: any) => Number(g.maxPercent) || 0));
        const asPctRef = (bandMax > 0 && bandRefFull > 0) ? Math.min(bandMax, bandRefFull) : (bandMax || bandRefFull || 100);
        const asPct = (v: any) => ((Number(v) || 0) / asPctRef) * 100;
        const sorted = [...gradingBandsForThis].sort((a: any, b: any) => asPct(a.minPercent) - asPct(b.minPercent));
        let matched: any = null;
        for (const g of sorted) {
          if (asPct(g.minPercent) <= percent + 0.0001) matched = g;
        }
        gradeInfo = matched || sorted.find((g: any) => String(g.status).toUpperCase() === 'FAIL') || sorted[0];
      }

      if (studentClass) {
        const curBest = classHighest.get(studentClassKey) ?? 0;
        if (totalMarks > curBest) classHighest.set(studentClassKey, totalMarks);
      }

      await tx.result.upsert({
        where: {
          studentId_examId_subjectId: {
            studentId: m.studentId,
            examId,
            subjectId
          }
        },
        update: {
          written: m.written,
          mcq: m.mcq,
          practical: m.practical,
          totalMarks,
          grade: gradeInfo?.grade || 'F',
          gp: gradeInfo?.gp || 0,
          isAbsent: false
        },
        create: {
          studentId: m.studentId,
          examId,
          subjectId,
          written: m.written,
          mcq: m.mcq,
          practical: m.practical,
          totalMarks,
          grade: gradeInfo?.grade || 'F',
          gp: gradeInfo?.gp || 0,
          isAbsent: false
        }
      });
    }

    // Handle absent students - auto-create absent result records
    const absentStudents = await tx.examAttendance.findMany({
      where: { examId, subjectId, status: 'ABSENT' }
    });

    for (const absent of absentStudents) {
      await tx.result.upsert({
        where: {
          studentId_examId_subjectId: {
            studentId: absent.studentId,
            examId,
            subjectId
          }
        },
        update: {
          isAbsent: true,
          written: 0,
          mcq: 0,
          practical: 0,
          totalMarks: 0,
          grade: 'ABSENT',
          gp: 0
        },
        create: {
          studentId: absent.studentId,
          examId,
          subjectId,
          isAbsent: true,
          written: 0,
          mcq: 0,
          practical: 0,
          totalMarks: 0,
          grade: 'ABSENT',
          gp: 0
        }
      });
    }

    // Merge existing per-class bests with this batch's, per class. (#7)
    const classHighestFinal = new Map<string, number>();
    for (const [c, vals] of existingByClass) {
      classHighestFinal.set(c, Math.max(...vals, classHighest.get(c) ?? 0));
    }
    for (const [c, v] of classHighest) {
      if (!classHighestFinal.has(c)) classHighestFinal.set(c, v);
    }

    // Update highestMarks per class+section within the same transaction.
    for (const [c, h] of classHighestFinal) {
      const studentIds = classStudentIdsByKey.get(c) ?? [];
      if (studentIds.length === 0) continue;
      await tx.result.updateMany({
        where: { examId, subjectId, studentId: { in: studentIds } },
        data: { highestMarks: h }
      });
    }

    return classHighestFinal;
  });

  res.json({ success: true, highestMarks: Object.fromEntries(result) });
});

// ===== Results reporting (overview / class / student) =====

function classSectionKey(cls?: string | null, section?: string | null) {
  return `${cls || ''}||${section || ''}`;
}

function resultIsAbsent(result: any) {
  return !!result?.isAbsent || result?.grade === 'ABSENT';
}

/** A student summary is absent when every/any relevant subject is marked absent. */
function studentSummaryIsAbsent(summary: any) {
  return !!summary?.isAbsent || !!summary?.hasAbsence
    || String(summary?.grade || '').toUpperCase() === 'ABSENT'
    || String(summary?.status || '').toUpperCase() === 'ABSENT';
}

function findResultSchedule(schedules: any[], result: any) {
  const student = result?.student;
  if (!student) return null;
  return schedules.find(s => s.subjectId === result.subjectId && s.class && s.class.name === student.class && s.class.section === student.section)
    || schedules.find(s => s.subjectId === result.subjectId && !s.class)
    || null;
}

function resultIsFailed(schedules: any[], failGrades: Set<string>, result: any) {
  if (resultIsAbsent(result)) return true;
  const schedule = findResultSchedule(schedules, result);
  if (schedule?.gradingSnapshot) {
    const snapshot = parseGradingSnapshot(schedule.gradingSnapshot);
    const band = Array.isArray(snapshot?.bands)
      ? snapshot.bands.find((b: any) => b.grade === result.grade)
      : null;
    if (band) return String(band.status).toUpperCase() === 'FAIL';
  }
  return !!(result.grade && failGrades.has(result.grade));
}

async function buildExamReport(examId: string) {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { type: true } });
  if (!exam) throw new Error('Exam not found');

  const [grading, schedules, rawResults, absentAttendances] = await Promise.all([
    prisma.gradingSystem.findMany({ where: { examTypeId: exam.typeId }, orderBy: { minPercent: 'desc' } }),
    prisma.examSchedule.findMany({ where: { examId }, include: { subject: true, class: true } }),
    prisma.result.findMany({
      where: { examId },
      include: { student: true }
    }),
    prisma.examAttendance.findMany({
      where: { examId, status: 'ABSENT' },
      include: { student: true },
    }),
  ]);

  // Exam attendance is authoritative for absence. Merge it into the result set
  // so students marked absent appear with an ABSENT result even if marks were
  // never saved for that subject.
  const results: any[] = rawResults;
  const resultKeys = new Set(results.map((r: any) => `${r.studentId}|${r.subjectId}`));
  const absentKeys = new Set<string>();
  for (const attendance of absentAttendances) {
    const key = `${attendance.studentId}|${attendance.subjectId}`;
    absentKeys.add(key);
    if (!resultKeys.has(key)) {
      results.push({
        id: `absent-${attendance.id}`,
        examId,
        studentId: attendance.studentId,
        subjectId: attendance.subjectId,
        written: 0,
        mcq: 0,
        practical: 0,
        totalMarks: 0,
        grade: 'ABSENT',
        gp: 0,
        isAbsent: true,
        highestMarks: 0,
        student: attendance.student,
      });
      resultKeys.add(key);
    }
  }
  for (const r of results) {
    if (absentKeys.has(`${r.studentId}|${r.subjectId}`)) {
      r.isAbsent = true;
      r.grade = 'ABSENT';
      r.written = 0;
      r.mcq = 0;
      r.practical = 0;
      r.totalMarks = 0;
      r.gp = 0;
    }
  }

  const failGrades = new Set<string>();
  grading.forEach((g) => { if (g.status === 'FAIL') failGrades.add(g.grade); });
  if (failGrades.size === 0) failGrades.add('F');

  const gradingScale = Math.max(1, ...grading.map((g) => Number(g.maxPercent) || 0));
  const gradingAsPercent = grading.map((g) => ({
    ...g,
    pctMin: ((Number(g.minPercent) || 0) / gradingScale) * 100,
    pctMax: ((Number(g.maxPercent) || 0) / gradingScale) * 100,
  }));
  const gradeForPercentage = (percentage: number) => {
    if (gradingAsPercent.length === 0) return '';
    const sorted = [...gradingAsPercent].sort((a, b) => b.pctMin - a.pctMin);
    const band = sorted.find((g) => percentage >= g.pctMin - 0.0001 && percentage <= g.pctMax + 0.0001);
    return band?.grade || sorted[sorted.length - 1]?.grade || '';
  };

  const subjectName = new Map<string, string>();
  const subjectFullMarksByClass = new Map<string, Map<string, number>>();
  const subjectDefaultFullMarks = new Map<string, number>();
  const subjectCreditHours = new Map<string, number>();
  for (const s of schedules) {
    subjectName.set(s.subjectId, s.subject?.name || s.subjectId);
    if (!subjectDefaultFullMarks.has(s.subjectId)) subjectDefaultFullMarks.set(s.subjectId, s.fullMarks ?? 100);
    if (!subjectCreditHours.has(s.subjectId)) subjectCreditHours.set(s.subjectId, Number(s.subject?.creditHours ?? 1) || 1);
    if (s.class?.name) {
      if (!subjectFullMarksByClass.has(s.subjectId)) subjectFullMarksByClass.set(s.subjectId, new Map());
      subjectFullMarksByClass.get(s.subjectId)!.set(classSectionKey(s.class.name, s.class.section), s.fullMarks ?? 100);
    }
  }

  const studentMap = new Map<string, { student: any; subjects: any[] }>();
  for (const r of results) {
    if (!studentMap.has(r.studentId)) studentMap.set(r.studentId, { student: r.student, subjects: [] });
    studentMap.get(r.studentId)!.subjects.push(r);
  }

  const students: any[] = [];
  for (const { student, subjects } of studentMap.values()) {
    if (!subjects.length) continue;
    
    // Check if ALL subjects are absent
    const allAbsent = subjects.every(r => resultIsAbsent(r));
    if (allAbsent) {
      students.push({
        studentId: student.id,
        name: student.name,
        admissionNo: student.admissionNo,
        avatar: student.avatar,
        class: student.class,
        section: student.section,
        roll: student.roll,
        status: 'FAIL',
        totalMarks: 0,
        fullMarks: 0,
        percentage: 0,
        gpa: 0,
        grade: 'F',
        passed: false,
        failed: true,
        hasAbsence: true,
        isAbsent: true,
        subjectCount: subjects.length
      });
      continue;
    }
    
    // Calculate marks only for non-absent subjects. Absence is tracked
    // separately and must never be counted as an academic failure.
    let totalMarks = 0, fullMarks = 0, gpSum = 0, gpCount = 0, creditSum = 0, failed = false, hasAbsence = false;
    for (const r of subjects) {
      if (resultIsAbsent(r)) {
        hasAbsence = true;
        continue;
      }
      totalMarks += r.totalMarks || 0;
      const fm = subjectFullMarksByClass.get(r.subjectId)?.get(classSectionKey(student.class, student.section))
        ?? subjectDefaultFullMarks.get(r.subjectId)
        ?? 100;
      fullMarks += fm;
      const ch = subjectCreditHours.get(r.subjectId) ?? 1;
      if (r.gp != null) { gpSum += r.gp * ch; gpCount++; creditSum += ch; }
      if (resultIsFailed(schedules, failGrades, r)) failed = true;
    }
    // Credit-weighted GPA: Î£(GP Ã— creditHours) / Î£(creditHours). (#11)
    const gpa = creditSum > 0 ? round2(gpSum / creditSum) : (gpCount ? round2(gpSum / gpCount) : 0);
    const percentage = fullMarks > 0 ? round2((totalMarks / fullMarks) * 100) : 0;
    if (hasAbsence) failed = true;
    const grade = failed ? 'F' : gradeForPercentage(percentage);
    const passed = !failed;
    students.push({
      studentId: student.id,
      name: student.name,
      admissionNo: student.admissionNo,
      avatar: student.avatar,
      class: student.class,
      section: student.section,
      roll: student.roll,
      totalMarks: round2(totalMarks),
      fullMarks: round2(fullMarks),
      percentage,
      gpa,
      grade,
      passed,
      failed,
      hasAbsence,
      status: failed ? 'FAIL' : 'PASS',
      subjectCount: subjects.length
    });
  }

  return { exam, grading, schedules, results, students, failGrades, subjectName, subjectDefaultFullMarks, subjectFullMarksByClass };
}

function subjectStatsForReport(report: Awaited<ReturnType<typeof buildExamReport>>, studentFilter?: Set<string>) {
  const map = new Map<string, { subject: string; totals: number[]; passCount: number; absent: number }>();
  for (const r of report.results) {
    if (studentFilter && !studentFilter.has(r.studentId)) continue;
    if (!map.has(r.subjectId)) map.set(r.subjectId, { subject: report.subjectName.get(r.subjectId) || r.subjectId, totals: [], passCount: 0, absent: 0 });
    const rec = map.get(r.subjectId)!;
    // Absentees did not sit the paper, so they are excluded from the subject
    // average and the subject pass-rate denominator.
    if (resultIsAbsent(r)) { rec.absent++; continue; }
    const fm = report.subjectFullMarksByClass.get(r.subjectId)?.get(classSectionKey(r.student?.class, r.student?.section))
      ?? report.subjectDefaultFullMarks.get(r.subjectId)
      ?? 100;
    rec.totals.push(fm > 0 ? (r.totalMarks / fm) * 100 : 0);
    if (!resultIsFailed(report.schedules, report.failGrades, r)) rec.passCount++;
  }
  return [...map.values()]
    .map((x) => {
      const gradedTotal = x.totals.length + x.absent;
      return {
        subject: x.subject,
        average: round2(x.totals.reduce((a, b) => a + b, 0) / (x.totals.length || 1)),
        passRate: round2((x.passCount / (gradedTotal || 1)) * 100),
        appeared: x.totals.length,
        absent: x.absent,
      };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

function rankStudents(list: any[]) {
  const sorted = [...list]
    .sort((a, b) => b.gpa - a.gpa || b.percentage - a.percentage || a.name.localeCompare(b.name));
  let previousKey: string | null = null;
  let previousRank = 0;
  return sorted.map((s, i) => {
    const key = `${s.gpa}|${s.percentage}`;
    const rank = key === previousKey ? previousRank : i + 1;
    previousKey = key;
    previousRank = rank;
    return { ...s, rank };
  });
}

app.get('/results/overview', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    let { examId, academicYear } = req.query as any;
    if (!examId) {
      const fallback = await prisma.exam.findFirst({
        where: academicYear ? { academicYear } : {},
        orderBy: { startDate: 'desc' }
      });
      examId = fallback?.id;
    }
    if (!examId) return res.status(400).json({ error: 'examId (or academicYear) is required' });

    const report = await buildExamReport(examId);
    const { students } = report;
    const total = students.length;
    const absent = students.filter(studentSummaryIsAbsent).length;
    const appeared = total - absent;
    const passed = students.filter((s) => s.passed).length;
    const failed = students.filter((s) => !s.passed).length;
    // Absentees are failed, so they stay in the pass-rate denominator.
    const passRate = total ? round2((passed / total) * 100) : 0;
    const average = appeared
      ? round2(students.filter((s) => !studentSummaryIsAbsent(s)).reduce((a, s) => a + s.percentage, 0) / appeared)
      : 0;

    const classMap = new Map<string, any[]>();
    for (const s of students) {
      const key = s.class || 'N/A';
      if (!classMap.has(key)) classMap.set(key, []);
      classMap.get(key)!.push(s);
    }
    const classPerformance = [...classMap.entries()]
      .map(([cls, arr]) => {
        const appearedArr = arr.filter((s) => !studentSummaryIsAbsent(s));
        const p = appearedArr.filter((s) => s.passed).length;
        return {
          class: cls,
          students: arr.length,
          appeared: appearedArr.length,
          absent: arr.length - appearedArr.length,
          passed: p,
          failed: arr.filter((s) => !s.passed).length,
          passRate: arr.length ? round2((p / arr.length) * 100) : 0,
          average: appearedArr.length ? round2(appearedArr.reduce((a, s) => a + s.percentage, 0) / appearedArr.length) : 0
        };
      })
      .sort((a, b) => a.class.localeCompare(b.class));

    const subjectPerformance = subjectStatsForReport(report);
    const ranked = rankStudents(students.filter((s) => !studentSummaryIsAbsent(s)));
    const topStudents = ranked.slice(0, 10).map((s) => ({ rank: s.rank, studentId: s.studentId, name: s.name, admissionNo: s.admissionNo, avatar: s.avatar, class: s.class, section: s.section, roll: s.roll, gpa: s.gpa, percentage: s.percentage, grade: s.grade, totalMarks: s.totalMarks }));
    const atRiskStudents = students
      .filter((s) => !studentSummaryIsAbsent(s) && (s.failed || s.gpa < 2.0))
      .sort((a, b) => a.gpa - b.gpa || b.percentage - a.percentage)
      .slice(0, 10)
      .map((s) => ({ studentId: s.studentId, name: s.name, admissionNo: s.admissionNo, avatar: s.avatar, class: s.class, section: s.section, roll: s.roll, gpa: s.gpa, percentage: s.percentage, grade: s.grade }));
    const weakestSubjects = [...subjectPerformance].sort((a, b) => a.average - b.average).slice(0, 5);
    const highestClass = classPerformance.length ? classPerformance.reduce((a, b) => (b.average > a.average ? b : a)) : null;
    const lowestClass = classPerformance.length ? classPerformance.reduce((a, b) => (b.average < a.average ? b : a)) : null;

    let previousExam = null;
    const prev = await prisma.exam.findFirst({
      where: { typeId: report.exam.typeId, startDate: { lt: report.exam.startDate } },
      orderBy: { startDate: 'desc' }
    });
    if (prev) {
      try {
        const prevReport = await buildExamReport(prev.id);
        const prevAppeared = prevReport.students.filter((s) => !studentSummaryIsAbsent(s));
        const prevAvg = prevAppeared.length
          ? round2(prevAppeared.reduce((a, s) => a + s.percentage, 0) / prevAppeared.length)
          : 0;
        previousExam = { id: prev.id, name: prev.name, average: prevAvg, avgChange: round2(average - prevAvg) };
      } catch (e) {
        previousExam = null;
      }
    }

    res.json({
      exam: { id: report.exam.id, name: report.exam.name, academicYear: report.exam.academicYear, type: report.exam.type?.name || '' },
      stats: { students: total, appeared, absent, passed, failed, passRate, average },
      classPerformance,
      subjectPerformance,
      analytics: { highestClass, lowestClass, topStudents, atRiskStudents, weakestSubjects },
      previousExam
    });
  } catch (error: any) {
    console.error('Error building results overview:', error);
    res.status(500).json({ error: 'Failed to build results overview', details: error.message });
  }
});

app.get('/results/class', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId, class: cls, section } = req.query as any;
    if (!examId || !cls) return res.status(400).json({ error: 'examId and class are required' });

    const report = await buildExamReport(examId);
    let students = report.students.filter((s) => s.class === cls);
    if (section) students = students.filter((s) => s.section === section);

    const total = students.length;
    const absent = students.filter(studentSummaryIsAbsent).length;
    const appeared = total - absent;
    const passed = students.filter((s) => s.passed).length;
    const failed = students.filter((s) => !s.passed).length;
    const average = appeared
      ? round2(students.filter((s) => !studentSummaryIsAbsent(s)).reduce((a, s) => a + s.percentage, 0) / appeared)
      : 0;
    const rankList = rankStudents(students);

    const subjectPerformance = subjectStatsForReport(report, new Set(students.map((s) => s.studentId)));

    res.json({
      exam: { id: report.exam.id, name: report.exam.name },
      class: cls,
      section: section || null,
      stats: { students: total, appeared, absent, passed, failed, passRate: total ? round2((passed / total) * 100) : 0, average },
      subjectPerformance,
      rankList
    });
  } catch (error: any) {
    console.error('Error building class results:', error);
    res.status(500).json({ error: 'Failed to build class results', details: error.message });
  }
});

app.get('/results/student', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId, studentId } = req.query as any;
    if (!examId || !studentId) return res.status(400).json({ error: 'examId and studentId are required' });

    const report = await buildExamReport(examId);
    const agg = report.students.find((s) => s.studentId === studentId);
    if (!agg) return res.status(404).json({ error: 'No results found for this student in the exam' });

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    const rows = report.results
      .filter((r) => r.studentId === studentId)
      .map((r) => ({
        subject: report.subjectName.get(r.subjectId) || r.subjectId,
        written: r.written,
        mcq: r.mcq,
        practical: r.practical,
        total: r.totalMarks,
        grade: r.grade || '',
        gp: r.gp ?? 0,
        highestMarks: r.highestMarks,
        isAbsent: resultIsAbsent(r),
      }))
      .sort((a, b) => a.subject.localeCompare(b.subject));

    const clsRanked = rankStudents(report.students
      .filter((s) => s.class === agg.class && s.section === agg.section));
    const position = clsRanked.find((s) => s.studentId === studentId)?.rank ?? 0;

    res.json({
      student: { id: student?.id, name: student?.name, admissionNo: student?.admissionNo, avatar: student?.avatar, class: student?.class, section: student?.section, roll: student?.roll },
      exam: { id: report.exam.id, name: report.exam.name },
      rows,
      totals: {
        totalMarks: agg.totalMarks,
        fullMarks: agg.fullMarks,
        percentage: agg.percentage,
        gpa: agg.gpa,
        grade: agg.grade,
        passed: agg.passed,
        isAbsent: !!agg.isAbsent,
        hasAbsence: !!agg.hasAbsence,
        status: agg.status,
      },
      position
    });
  } catch (error: any) {
    console.error('Error building student results:', error);
    res.status(500).json({ error: 'Failed to build student results', details: error.message });
  }
});

// ============================================================================
// RESULT LIFECYCLE, PUBLISHING, VALIDATION, RANKING, PERFORMANCE & REPORT CARD
// (Phase 1: Result & Academic Performance module)
// ============================================================================

const RESULT_STATUSES = ['Draft', 'Verification', 'Finalized', 'Published'] as const;
const ALLOWED_STATUS_TRANSITIONS: Record<string, string[]> = {
  Draft: ['Verification'],
  Verification: ['Finalized', 'Draft'],
  Finalized: ['Verification', 'Draft'],
  Published: [],
};
const RANK_MODES = ['TotalMarks', 'Percentage', 'GPA', 'WeightedAcademicScore'] as const;

function resultStatusAdvance(from: string, to: string): boolean {
  const allowed = ALLOWED_STATUS_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

// Weighted Academic Score: for every exam in the academic year that has a
// configured weight (>0), weight that exam's student percentage by its weight,
// then average across those exams. Used for the 'WeightedAcademicScore' rank mode.
async function weightedAcademicScoreMap(academicYear: string): Promise<Map<string, number>> {
  const exams = await prisma.exam.findMany({
    where: { academicYear, weight: { gt: 0 }, status: { in: ['Finalized', 'Published'] } },
    orderBy: { startDate: 'asc' }
  });
  const acc = new Map<string, { sum: number; totalW: number }>();
  for (const exam of exams) {
    let students: any[] = [];
    try {
      students = (await buildExamReport(exam.id)).students;
    } catch (e) {
      // Don't silently skip exams that fail to build â€” log why. (#12)
      console.warn(`weightedAcademicScoreMap: skipping weight for exam ${exam.id} ("${exam.name}")`, (e as Error)?.message);
      continue;
    }
    for (const s of students) {
      const cur = acc.get(s.studentId) || { sum: 0, totalW: 0 };
      cur.sum += (s.percentage || 0) * exam.weight;
      cur.totalW += exam.weight;
      acc.set(s.studentId, cur);
    }
  }
  const result = new Map<string, number>();
  for (const [id, v] of acc) result.set(id, v.totalW ? round2(v.sum / v.totalW) : 0);
  return result;
}

// Re-rank a list of student summaries by a given mode. Each entry must have
// totalMarks, percentage, gpa and (optionally) weightedScore.
function rankStudentsBy(list: any[], mode: string, weighted = new Map<string, number>()): any[] {
  const scoreOf = (s: any): number => {
    switch (mode) {
      case 'TotalMarks': return s.totalMarks || 0;
      case 'Percentage': return s.percentage || 0;
      case 'WeightedAcademicScore': return weighted.get(s.studentId) ?? 0;
      case 'GPA':
      default: return s.gpa || 0;
    }
  };
  const sorted = [...list]
    .sort((a, b) => {
      const d = scoreOf(b) - scoreOf(a);
      if (d !== 0) return d;
      return (b.percentage || 0) - (a.percentage || 0) || a.name.localeCompare(b.name);
    });
  let previousScore: number | null = null;
  let previousRank = 0;
  return sorted.map((s, i) => {
    const score = scoreOf(s);
    const rank = score === previousScore ? previousRank : i + 1;
    previousScore = score;
    previousRank = rank;
    return { ...s, rank, rankScore: score };
  });
}

// ---- Status transition ----
app.post('/results/:examId/status', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;
    const { status } = req.body || {};
    if (!status || !RESULT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${RESULT_STATUSES.join(', ')}` });
    }
    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    if (!exam) return res.status(404).json({ error: 'Exam not found' });
    if (!resultStatusAdvance(exam.status, status)) {
      return res.status(409).json({ error: `Cannot transition from '${exam.status}' to '${status}'` });
    }
    const updated = await prisma.exam.update({
      where: { id: examId },
      data: {
        status,
        updatedAt: new Date(),
        ...(status === 'Published' ? { publishedAt: new Date(), publishedBy: (req as any).user?.email } : {}),
      }
    });

    // Cascade the exam-level status onto every Result row so an exam is never
    // "Published" while individual results remain at an older stage. (#15)
    await prisma.result.updateMany({
      where: { examId },
      data: {
        status,
        verifiedAt: status === 'Finalized' ? new Date() : null,
      },
    });

    res.json({ id: updated.id, status: updated.status, publishedAt: updated.publishedAt, publishedBy: updated.publishedBy });
  } catch (error: any) {
    console.error('Error transitioning result status:', error);
    res.status(500).json({ error: 'Failed to update result status', details: error.message });
  }
});

// ---- Publish ----
// Count results whose totalMarks exceed the scheduled full marks for their
// class+section+subject. Used as a publish-time integrity gate so an exam with
// impossible totals (e.g. 519/450) cannot be published.
async function countResultOverMax(examId: string): Promise<number> {
  const [schedules, results, students, classes] = await Promise.all([
    prisma.examSchedule.findMany({ where: { examId }, include: { subject: true } }),
    prisma.result.findMany({ where: { examId } }),
    prisma.student.findMany({ select: { id: true, class: true, section: true } }),
    prisma.schoolClass.findMany({ select: { id: true, name: true, section: true } }),
  ]);
  const classIdByNameSection = new Map(classes.map((c) => [c.name + '|' + c.section, c.id]));
  const studentClassId = new Map(students.map((s) => [s.id, classIdByNameSection.get(s.class + '|' + s.section) || '']));
  const scheduleByKey = new Map(schedules.map((s) => [(s.classId || '') + '|' + s.subjectId, s]));

  let overMax = 0;
  for (const r of results) {
    const clsId = studentClassId.get(r.studentId) || '';
    const sch = scheduleByKey.get(clsId + '|' + r.subjectId) || scheduleByKey.get('|' + r.subjectId);
    const full = sch ? Number(sch.fullMarks || 0) : 100;
    if (Number(r.totalMarks || 0) > full) overMax++;
  }
  return overMax;
}

app.post('/results/:examId/publish', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;
    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    if (!exam) return res.status(404).json({ error: 'Exam not found' });
    if (exam.status !== 'Finalized') {
      return res.status(409).json({ error: 'Exam must be Finalized before publishing' });
    }

    const report = await buildExamReport(examId);
    if (report.results.length === 0) {
      return res.status(409).json({ error: 'Cannot publish an exam with no results' });
    }

    // Publish-time integrity gate: refuse to publish if any result exceeds its
    // scheduled full marks. Fix the mark scale or rescale marks first.
    const overMax = await countResultOverMax(examId);
    if (overMax > 0) {
      return res.status(409).json({
        error: `Cannot publish: ${overMax} result(s) exceed scheduled full marks. Fix the mark scale or rescale marks before publishing.`,
      });
    }

    // Grade-scale gate: a mark-based grading template (e.g. 50 marks) must be
    // paired with schedules using the same scale, otherwise identical marks are
    // graded against the wrong denominator.
    const scaleMismatches = await findScheduleScaleMismatches(examId);
    if (scaleMismatches.length > 0) {
      const sample = scaleMismatches.slice(0, 5)
        .map((m) => `${m.subject}${m.classLabel ? ` (${m.classLabel})` : ''}: ${m.fullMarks}/${m.expected}`)
        .join('; ');
      return res.status(409).json({
        error: `Cannot publish: ${scaleMismatches.length} schedule(s) use a different mark scale than the grading template (${sample}). Fix the schedule full marks or the grading template first.`,
      });
    }

    const rankBy = (req.body?.rankBy || 'GPA') as string;
    if (!RANK_MODES.includes(rankBy as any)) {
      return res.status(400).json({ error: `Invalid rankBy. Allowed: ${RANK_MODES.join(', ')}` });
    }

    let weighted = new Map<string, number>();
    if (rankBy === 'WeightedAcademicScore') weighted = await weightedAcademicScoreMap(exam.academicYear);

    // Freeze ranking snapshot (within same class+section).
    const byClass = new Map<string, any[]>();
    for (const s of report.students) {
      const key = `${s.class || 'N/A'}|${s.section || ''}`;
      if (!byClass.has(key)) byClass.set(key, []);
      byClass.get(key)!.push(s);
    }
    const ranking = Array.from(byClass.entries()).map(([key, group]) => {
      const [cls, section] = key.split('|');
      const arr = rankStudentsBy(group, rankBy, weighted);
      return {
        class: cls,
        section,
        entries: arr.map((s) => ({
          studentId: s.studentId,
          name: s.name,
          admissionNo: s.admissionNo,
          avatar: s.avatar,
          roll: s.roll,
          gpa: s.gpa,
          percentage: s.percentage,
          grade: s.grade,
          totalMarks: s.totalMarks,
          rank: s.rank,
          rankScore: s.rankScore
        }))
      };
    });

    const adminUser = (req as any).user?.email || null;
    const now = new Date();

    const publish = await prisma.$transaction(async (tx) => {
      const saved = await tx.resultPublish.upsert({
        where: { examId },
        update: {
          rankBy,
          publishedBy: adminUser,
          publishedAt: now,
          rankSnapshot: ranking as any
        },
        create: {
          examId,
          rankBy,
          publishedBy: adminUser,
          publishedAt: now,
          rankSnapshot: ranking as any
        }
      });

      await tx.exam.update({
        where: { id: examId },
        data: { status: 'Published', publishedAt: now, publishedBy: adminUser, updatedAt: now }
      });

      // Cascade the Published status onto every Result row (#15).
      await tx.result.updateMany({
        where: { examId },
        data: { status: 'Published', verifiedAt: now },
      });

      return saved;
    });

    res.json({ examId, status: 'Published', rankBy, publishId: publish.id, ranking });
  } catch (error: any) {
    console.error('Error publishing results:', error);
    res.status(500).json({ error: 'Failed to publish results', details: error.message });
  }
});

// ---- Unpublish ----
app.post('/results/:examId/unpublish', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;
    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    if (!exam) return res.status(404).json({ error: 'Exam not found' });
    if (exam.status !== 'Published') {
      return res.status(409).json({ error: 'Only a published exam can be unpublished' });
    }
    await prisma.$transaction(async (tx) => {
      await tx.exam.update({
        where: { id: examId },
        data: { status: 'Finalized', publishedAt: null, publishedBy: null, updatedAt: new Date() }
      });
      // Unpublishing is an edit workflow -> results become editable (Finalized). (#15)
      await tx.result.updateMany({
        where: { examId },
        data: { status: 'Finalized' },
      });
      // Remove the frozen public ranking so a later publish cannot expose stale data.
      await tx.resultPublish.deleteMany({ where: { examId } });
    });
    res.json({ examId, status: 'Finalized' });
  } catch (error: any) {
    console.error('Error unpublishing results:', error);
    res.status(500).json({ error: 'Failed to unpublish results', details: error.message });
  }
});

// ---- Validation / result readiness ----
app.get('/results/:examId/validation', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;
    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    const [schedules, results, students, allGrading] = await Promise.all([
      prisma.examSchedule.findMany({ where: { examId }, include: { subject: true, class: true } }),
      prisma.result.findMany({ where: { examId }, include: { student: true } }),
      prisma.student.findMany({ select: { id: true, name: true, class: true, section: true } }),
      prisma.gradingSystem.findMany({ orderBy: { minPercent: 'desc' } })
    ]);

    const issues: any[] = [];
    // Subject list that should have marks (only subjects scheduled for this exam).
    const subjectIds = [...new Set(schedules.map((s) => s.subjectId))];
    // A schedule belongs to a grade+section (SchoolClass record). Only the grades AND
    // sections actually scheduled for this exam count toward the readiness criteria.
    // A schedule with no class is global (applies to every grade/section).
    const keyOf = (cl: string, sec: string) => `${cl}|${sec}`;
    const scheduledClassKeys = new Set(
      schedules.filter((s) => s.class).map((s) => keyOf(s.class!.name, s.class!.section))
    );
    const hasGlobalSchedule = schedules.some((s) => !s.class);
    const enrolled = hasGlobalSchedule
      ? students
      : students.filter((st) => scheduledClassKeys.has(keyOf(st.class, st.section)));
    // Subjects that must have marks for a grade+section (global schedules count for all).
    const subjectsForClass = (cl: string, sec: string) =>
      new Set(
        schedules.filter((s) => !s.class || keyOf(s.class!.name, s.class!.section) === keyOf(cl, sec)).map((s) => s.subjectId)
      );
    // Applicable (student, subject) pairs for this exam â€” only these count in the criteria.
    const applicableKeys = new Set<string>();
    for (const st of enrolled) {
      for (const sid of subjectsForClass(st.class, st.section)) applicableKeys.add(`${st.id}|${sid}`);
    }

    // Missing marks: students without a result for a scheduled subject applicable to their class.
    // Counts unique (student, subject) pairs â€” duplicate schedule rows (e.g. same-named
    // class records) must not inflate the tally.
    const resultKey = new Set(results.map((r) => `${r.studentId}|${r.subjectId}`));
    let missingMarks = 0;
    for (const st of enrolled) {
      for (const sid of subjectsForClass(st.class, st.section)) {
        const key = `${st.id}|${sid}`;
        if (!resultKey.has(key)) {
          missingMarks++;
          if (issues.length < 20) {
            const subjName = schedules.find((s) => s.subjectId === sid)?.subject?.name || sid;
            issues.push({ type: 'missing_marks', message: `${st.name} missing ${subjName} marks`, studentId: st.id, subjectId: sid });
          }
        }
      }
    }

    // A practical component is only "required" for a (class, subject) when the
    // schedule actually configures one. Resolve it exactly the way marks entry
    // does: prefer the schedule's own snapshot, else the grading template
    // referenced by the schedule's gradingTypeId (or the exam type).
    // Without this, subjects with no practical exam were still reported as
    // "missing practical marks".
    const gradingByType = new Map<string, typeof allGrading>();
    for (const g of allGrading) {
      const key = g.examTypeId ?? '__template__';
      if (!gradingByType.has(key)) gradingByType.set(key, []);
      gradingByType.get(key)!.push(g);
    }
    const defaultGrading = gradingByType.get(exam.typeId ?? '') || [];
    const practicalRequiredFor = (schedule: { practicalFullMarks?: number | null; gradingTypeId?: string | null }) => {
      const tpl = (gradingByType.get(schedule.gradingTypeId || exam.typeId || '') || defaultGrading)[0] as any;
      const practicalFull = (schedule.practicalFullMarks || 0) > 0 ? schedule.practicalFullMarks : (tpl?.practicalFull ?? 0);
      return (practicalFull || 0) > 0;
    };
    const scheduleByClassSubject = new Map<string, (typeof schedules)[number]>();
    const globalScheduleBySubject = new Map<string, (typeof schedules)[number]>();
    for (const s of schedules) {
      if (s.class) scheduleByClassSubject.set(`${keyOf(s.class.name, s.class.section)}|${s.subjectId}`, s);
      else if (!globalScheduleBySubject.has(s.subjectId)) globalScheduleBySubject.set(s.subjectId, s);
    }
    const studentById = new Map(students.map((s) => [s.id, s]));

    // Missing practical marks â€” only for pairs whose subject really has a
    // practical component in this exam.
    let missingPractical = 0;
    for (const r of results) {
      if (!applicableKeys.has(`${r.studentId}|${r.subjectId}`)) continue;
      const st = studentById.get(r.studentId);
      if (!st) continue;
      // Class-specific schedule wins; a global schedule (no class) applies to
      // every grade and decides the component split for that subject.
      const effective = scheduleByClassSubject.get(`${keyOf(st.class, st.section)}|${r.subjectId}`)
        || globalScheduleBySubject.get(r.subjectId);
      if (!effective || !practicalRequiredFor(effective)) continue;
      if ((r.practical == null || r.practical === 0) && r.written > 0) {
        missingPractical++;
        if (issues.length < 30) issues.push({ type: 'missing_practical', message: `${r.student?.name || r.studentId} missing practical marks`, studentId: r.studentId, subjectId: r.subjectId });
      }
    }

    // Marks exceeding maximum (per-class full marks from schedule).
    let overMax = 0;
    const subjectFull = new Map<string, Map<string, number>>();
    for (const sch of schedules) {
      if (sch.class) {
        const k = keyOf(sch.class.name, sch.class.section);
        if (!subjectFull.has(sch.subjectId)) subjectFull.set(sch.subjectId, new Map());
        subjectFull.get(sch.subjectId)!.set(k, Number(sch.fullMarks ?? 100));
      }
    }
    const studentClassMap = new Map(students.map((s) => [s.id, keyOf(s.class, s.section)]));
    for (const r of results) {
      const cl = studentClassMap.get(r.studentId);
      const fm = cl && subjectFull.get(r.subjectId)?.get(cl);
      if (fm != null && r.totalMarks > Number(fm)) {
        overMax++;
        if (issues.length < 40) issues.push({ type: 'over_max', message: `${r.subjectId} for ${r.student?.name || r.studentId} exceeds max (${r.totalMarks}/${fm})`, studentId: r.studentId, subjectId: r.subjectId });
      }
    }

    // Attendance availability: does at least one attended student have any attendance?
    const attCount = await prisma.attendance.count({
      where: { studentId: { in: enrolled.map((s) => s.id) } }
    });
    if (attCount === 0 && issues.length < 60) {
      issues.push({ type: 'attendance', message: 'No attendance records found for enrolled students' });
    }

    // Real duplicate result detection (#13): count rows sharing the same
    // (studentId, examId, subjectId) composite key, which the unique index
    // should prevent but legacy data may still violate.
    const dupGroups = await prisma.result.groupBy({
      by: ['studentId', 'examId', 'subjectId'],
      where: { examId },
      _count: true,
      having: { studentId: { _count: { gt: 1 } } },
    });
    let duplicateCount = 0;
    for (const g of dupGroups) {
      duplicateCount += g._count || 0;
      if (issues.length < 50) {
        issues.push({
          type: 'duplicate',
          message: `Duplicate result rows (${g._count}) for student ${g.studentId}, subject ${g.subjectId}`,
          studentId: g.studentId,
          subjectId: g.subjectId,
        });
      }
    }

    // Grade-scale consistency: mark-based templates (e.g. 50 marks) must match
    // the schedule's full marks. Surfaced here so the admin sees it BEFORE
    // publishing instead of discovering a wrong grade later.
    const scaleMismatches = await findScheduleScaleMismatches(examId);
    for (const m of scaleMismatches.slice(0, 20)) {
      issues.push({
        type: 'scale_mismatch',
        message: `${m.subject}${m.classLabel ? ` (${m.classLabel})` : ''} uses ${m.fullMarks} marks but the grading template expects ${m.expected}`,
        scheduleId: m.scheduleId,
      });
    }

    const expectedMarks = enrolled.reduce((sum, st) => sum + subjectsForClass(st.class, st.section).size, 0);
    const totalChecks = Math.max(1, subjectIds.length > 0 ? expectedMarks : 1);
    const penaltyScore = missingMarks * 2 + missingPractical + overMax + duplicateCount * 3;
    const health = Math.max(0, Math.min(100, Math.round(100 - (penaltyScore / totalChecks) * 100)));

    // --- Class-wise breakdown per grade+section scheduled for this exam ---
    // Only cover grade+section groups that are scheduled (all sections when a global schedule exists).
    const classSet = new Set<string>();
    if (hasGlobalSchedule) {
      for (const s of students) if (s.class && s.section) classSet.add(keyOf(s.class, s.section));
    }
    // also include grade+section groups that appear only in schedules
    for (const sch of schedules) if (sch.class?.name) classSet.add(keyOf(sch.class.name, sch.class.section));
    const classBreakdown = Array.from(classSet).sort().map((clsKey) => {
      const [clsName, secName] = clsKey.split('|');
      const clsDisplay = secName ? `${clsName} - Section ${secName}` : clsName;
      const enrolledInClass = students.filter((s) => keyOf(s.class, s.section) === clsKey);
      const applicableSchedules = schedules.filter((sch) => !sch.class || keyOf(sch.class.name, sch.class.section) === clsKey);
      const applicableSubjectIds = [...new Set(applicableSchedules.map((s) => s.subjectId))];
      const expected = enrolledInClass.length * applicableSubjectIds.length;
      const entered = results.filter((r) => {
        const cl = studentClassMap.get(r.studentId);
        return cl === clsKey && applicableSubjectIds.includes(r.subjectId);
      }).length;
      const classMissing = Math.max(0, expected - entered);
      const classOverMax = results.filter((r) => {
        const cl = studentClassMap.get(r.studentId);
        if (cl !== clsKey) return false;
        const fm = subjectFull.get(r.subjectId)?.get(clsKey);
        return fm != null && r.totalMarks > Number(fm);
      }).length;
      // missing per subject for tooltip
      const missingBySubject = applicableSubjectIds.map((sid) => {
        const subjName = schedules.find((s) => s.subjectId === sid)?.subject?.name || sid;
        const miss = enrolledInClass.filter((st) => !resultKey.has(`${st.id}|${sid}`)).length;
        return { subjectId: sid, subject: subjName, missing: miss };
      }).filter((x) => x.missing > 0);
      return {
        class: clsDisplay,
        enrolled: enrolledInClass.length,
        subjects: applicableSubjectIds.length,
        expected,
        entered,
        missing: classMissing,
        overMax: classOverMax,
        missingBySubject,
      };
    });

    const remainingMarks = missingMarks;
    // Inconsistencies: written+mcq+practical vs fullMarks (already overMax) plus component-level sanity
    const inconsistencies = issues
      .filter((iss) => iss.type === 'over_max' || iss.type === 'missing_marks')
      .slice(0, 20);

    const run = await prisma.resultValidationRun.create({
      data: {
        examId,
        health,
        issues: issues.slice(0, 100) as any
      }
    });

    res.json({
      exam: { id: exam.id, name: exam.name, status: exam.status },
      health,
      checks: {
        allStudentsHaveMarks: missingMarks === 0,
        allSubjectsHaveMarks: subjectIds.length > 0 && missingMarks === 0,
        noMarksExceedMax: overMax === 0,
        noDuplicateResults: duplicateCount === 0,
        practicalMarksEntered: missingPractical === 0,
        attendanceAvailable: attCount > 0,
        scaleMatchesTemplate: scaleMismatches.length === 0
      },
      counts: { missingMarks, missingPractical, overMax, duplicateCount, scaleMismatches: scaleMismatches.length },
      // extended for inline verification panel
      remainingMarks,
      classBreakdown,
      inconsistencies,
      issues: issues.slice(0, 100),
      runId: run.id
    });
  } catch (error: any) {
    console.error('Error validating results:', error);
    res.status(500).json({ error: 'Failed to validate results', details: error.message });
  }
});

// ---- Rank config + frozen rank ----
app.post('/results/:examId/rank-config', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;
    const { rankBy } = req.body || {};
    if (!RANK_MODES.includes(rankBy as any)) {
      return res.status(400).json({ error: `Invalid rankBy. Allowed: ${RANK_MODES.join(', ')}` });
    }
    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    if (!exam) return res.status(404).json({ error: 'Exam not found' });
    if (exam.status === 'Published') {
      return res.status(409).json({ error: 'Unpublish results before changing the ranking mode' });
    }
    const publish = await prisma.resultPublish.upsert({
      where: { examId },
      update: { rankBy },
      create: { examId, rankBy, publishedBy: (req as any).user?.email || null }
    });
    res.json({ examId, rankBy, publishId: publish.id });
  } catch (error: any) {
    console.error('Error saving rank config:', error);
    res.status(500).json({ error: 'Failed to save rank config', details: error.message });
  }
});

app.get('/results/:examId/rank', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;
    const publish = await prisma.resultPublish.findUnique({ where: { examId } });
    if (!publish?.rankSnapshot) {
      return res.status(404).json({ error: 'No published ranking snapshot yet. Publish results first.' });
    }
    res.json({ examId, rankBy: publish.rankBy, rankSnapshot: publish.rankSnapshot, publishedAt: publish.publishedAt });
  } catch (error: any) {
    console.error('Error fetching ranking:', error);
    res.status(500).json({ error: 'Failed to fetch ranking', details: error.message });
  }
});

app.get('/results/:examId/rank-config', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;
    const publish = await prisma.resultPublish.findUnique({ where: { examId } });
    res.json({ examId, rankBy: publish?.rankBy || 'GPA', published: !!publish?.rankSnapshot });
  } catch (error: any) {
    console.error('Error fetching rank config:', error);
    res.status(500).json({ error: 'Failed to fetch rank config', details: error.message });
  }
});

// ---- Student performance aggregation (multi-term progression) ----
app.get('/student/:id/performance', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const student = await prisma.student.findUnique({ where: { id: req.params.id } });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const [results, subjects, exams] = await Promise.all([
      prisma.result.findMany({ where: { studentId: student.id }, include: { exam: { include: { type: true } } }, orderBy: { createdAt: 'asc' } }),
      prisma.subject.findMany({ select: { id: true, name: true } }),
      prisma.exam.findMany({ orderBy: { startDate: 'asc' }, select: { id: true, name: true, academicYear: true, status: true, type: { select: { name: true } } } })
    ]);
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));

    // Per subject: ordered list of (exam, percent).
    const subjectTrend = new Map<string, { subjectId: string; subject: string; points: any[] }>();
    const orderByDate = new Map<string, number>();
    exams.forEach((e, i) => orderByDate.set(e.id, i));

    for (const r of results) {
      if (!subjectTrend.has(r.subjectId)) {
        subjectTrend.set(r.subjectId, { subjectId: r.subjectId, subject: subjectName.get(r.subjectId) || r.subjectId, points: [] });
      }
      subjectTrend.get(r.subjectId)!.points.push({
        examId: r.examId,
        examName: r.exam.name,
        examType: r.exam.type?.name || '',
        academicYear: r.exam.academicYear,
        written: r.written,
        mcq: r.mcq,
        practical: r.practical,
        total: r.totalMarks,
        grade: r.grade,
        gpa: r.gp,
        seq: orderByDate.get(r.examId) ?? 0
      });
    }
    for (const [k, v] of subjectTrend) v.points.sort((a, b) => a.seq - b.seq);

    // Overall per exam.
    const examSummaries = new Map<string, { totalMarks: number; fullMarks: number; percentage: number }>();
    for (const r of results) {
      const cur = examSummaries.get(r.examId) || { totalMarks: 0, fullMarks: 0, percentage: 0 };
      cur.totalMarks += r.totalMarks || 0;
      cur.fullMarks += 100; // default; refined by report below when available
      examSummaries.set(r.examId, cur);
    }

    // Build precise exam aggregate via buildExamReport for each exam with results.
    const reportAgg = new Map<string, any>();
    for (const examId of examSummaries.keys()) {
      try {
        const report = await buildExamReport(examId);
        const agg = report.students.find((s) => s.studentId === student.id);
        if (agg) reportAgg.set(examId, agg);
      } catch (e) { /* ignore */ }
    }

    const overall: any[] = [];
    for (const exam of exams) {
      const agg = reportAgg.get(exam.id);
      if (!agg) continue;
      overall.push({
        examId: exam.id,
        examName: exam.name,
        examType: exam.type?.name || '',
        academicYear: exam.academicYear,
        status: exam.status,
        totalMarks: agg.totalMarks,
        fullMarks: agg.fullMarks,
        percentage: agg.percentage,
        gpa: agg.gpa,
        grade: agg.grade,
        passed: agg.passed
      });
    }

    res.json({
      student: { id: student.id, name: student.name, class: student.class, section: student.section, roll: student.roll },
      subjectTrend: Array.from(subjectTrend.values()),
      overall
    });
  } catch (error: any) {
    console.error('Error building student performance:', error);
    res.status(500).json({ error: 'Failed to build student performance', details: error.message });
  }
});

// ---- Report card data ----
/** Shared report-card builder used by the admin and student endpoints. */
async function buildStudentReportCard(examId: string, studentId: string, userEmail?: string) {
  const report = await buildExamReport(examId);
  const agg = report.students.find((s) => s.studentId === studentId);
  if (!agg) return null;

  const student = await prisma.student.findUnique({ where: { id: studentId } });
  const institute =
    (userEmail ? await prisma.institute.findUnique({ where: { email: userEmail } }) : null) ??
    (await prisma.institute.findFirst());

  const rows = report.results
    .filter((r: any) => r.studentId === studentId)
    .map((r: any) => ({
      subject: report.subjectName.get(r.subjectId) || r.subjectId,
      written: r.written,
      mcq: r.mcq,
      practical: r.practical,
      total: r.totalMarks,
      fullMarks: report.subjectFullMarksByClass.get(r.subjectId)?.get(classSectionKey(student?.class, student?.section))
        ?? report.subjectDefaultFullMarks.get(r.subjectId)
        ?? 100,
      grade: r.grade || '',
      gp: r.gp ?? 0,
      highestMarks: r.highestMarks,
      isAbsent: resultIsAbsent(r)
    }))
    .sort((a: any, b: any) => a.subject.localeCompare(b.subject));

  // Rank within class+section.
  const clsRanked = rankStudents(report.students
    .filter((s: any) => s.class === agg.class && s.section === agg.section));
  const position = clsRanked.find((s: any) => s.studentId === studentId)?.rank ?? 0;

  // Attendance percentage.
  const attendance = await prisma.attendance.findMany({ where: { studentId } });
  const present = attendance.filter((a) => normalizeAttendanceStatus(a.status) === 'Present').length;
  const attendancePct = attendance.length ? Math.round((present / attendance.length) * 100) : 0;

  return {
    institute: { name: institute?.name, logo: institute?.logo, address: institute?.address, phone: institute?.phone, email: institute?.email, targetLine: institute?.targetLine },
    student: { id: student?.id, name: student?.name, admissionNo: student?.admissionNo, avatar: student?.avatar, roll: student?.roll, class: student?.class, section: student?.section },
    exam: { id: report.exam.id, name: report.exam.name, academicYear: report.exam.academicYear, type: report.exam.type?.name || '' },
    rows,
    totals: {
      totalMarks: agg.totalMarks,
      fullMarks: agg.fullMarks,
      percentage: agg.percentage,
      gpa: agg.gpa,
      grade: agg.grade,
      passed: agg.passed,
      isAbsent: !!agg.isAbsent,
      hasAbsence: !!agg.hasAbsence,
      status: agg.status,
    },
    position,
    attendance: { present, total: attendance.length, percentage: attendancePct }
  };
}

app.get('/results/:examId/report-card', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;
    const { studentId } = req.query as any;
    if (!studentId) return res.status(400).json({ error: 'studentId is required' });

    const user = (req as any).user;
    const body = await buildStudentReportCard(examId, studentId, user?.email);
    if (!body) return res.status(404).json({ error: 'No results for this student in this exam' });

    res.json(body);
  } catch (error: any) {
    console.error('Error building report card:', error);
    res.status(500).json({ error: 'Failed to build report card', details: error.message });
  }
});

// ---- Teacher results view ----
app.get('/teacher/results/my', authMiddleware, checkRole(['Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const teacher = await prisma.teacher.findFirst({
      where: { email: user.email },
      include: { classes: true, permission: true }
    });
    if (!teacher) return res.status(404).json({ error: 'Teacher not found' });

    const examId = typeof req.query.examId === 'string' ? req.query.examId : '';

    // Resolve assigned (class, subject) pairs.
    const pairs = await prisma.classSubjectTeacher.findMany({
      where: { teacherId: teacher.id },
      include: { class: true, subject: true }
    });

    // If no explicit pairs, fall back to permission/resolved subject approach.
    let assignedPairs = pairs.map((p: any) => ({ classId: p.classId, subjectId: p.subjectId, className: p.class.name, section: p.class.section, subjectName: p.subject.name }));
    if (assignedPairs.length === 0) {
      const subject = await prisma.subject.findFirst({ where: { name: String((teacher as any).subject || '') } });
      const classes = await teacherScopeClasses(teacher, 'marks');
      assignedPairs = classes.map((c: any) => ({
        classId: c.id,
        subjectId: subject?.id || '',
        className: c.name,
        section: c.section,
        subjectName: (teacher as any).subject || ''
      }));
    }

    if (!examId) {
      // List subjects with aggregate stats.
      const out = [];
      for (const p of assignedPairs) {
        const students = await prisma.student.findMany({
          where: { class: p.className, section: p.section },
          select: { id: true }
        });
        const results = await prisma.result.findMany({
          where: { studentId: { in: students.map((s) => s.id) }, subjectId: p.subjectId },
          select: { totalMarks: true, isAbsent: true, grade: true }
        });
        const absentResults = results.filter((r) => resultIsAbsent(r));
        const presentTotals = results.filter((r) => !resultIsAbsent(r)).map((r) => r.totalMarks);
        out.push({
          classId: p.classId,
          className: p.className,
          section: p.section,
          subjectId: p.subjectId,
          subject: p.subjectName,
          studentCount: students.length,
          average: presentTotals.length ? round2(presentTotals.reduce((a, b) => a + b, 0) / presentTotals.length) : 0,
          highest: presentTotals.length ? Math.max(...presentTotals) : 0,
          lowest: presentTotals.length ? Math.min(...presentTotals) : 0,
          marksEntered: presentTotals.length,
          absent: absentResults.length,
        });
      }
      return res.json({ subjectGroups: out });
    }

    // Per-student marks for a requested (exam, subject) pair.
    const subjects = await prisma.subject.findMany({ select: { id: true, name: true } });
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
    const out = [];
    for (const p of assignedPairs) {
      const students = await prisma.student.findMany({
        where: { class: p.className, section: p.section },
        orderBy: { roll: 'asc' },
        select: { id: true, name: true, roll: true, avatar: true, admissionNo: true }
      });
      const [results, absentAttendances] = await Promise.all([
        prisma.result.findMany({
          where: { examId, subjectId: p.subjectId, studentId: { in: students.map((s) => s.id) } }
        }),
        prisma.examAttendance.findMany({
          where: { examId, subjectId: p.subjectId, studentId: { in: students.map((s) => s.id) }, status: 'ABSENT' },
          select: { studentId: true }
        })
      ]);
      const resultMap = new Map(results.map((r) => [r.studentId, r]));
      const absentIds = new Set(absentAttendances.map((a) => a.studentId));
      out.push({
        classId: p.classId,
        className: p.className,
        section: p.section,
        subjectId: p.subjectId,
        subject: subjectName.get(p.subjectId) || p.subjectName,
        students: students.map((s) => {
          const r = resultMap.get(s.id);
          const absent = absentIds.has(s.id) || resultIsAbsent(r);
          return {
            studentId: s.id,
            name: s.name,
            roll: s.roll,
            avatar: s.avatar,
            admissionNo: s.admissionNo,
            isAbsent: absent,
            written: absent ? null : (r?.written ?? null),
            mcq: absent ? null : (r?.mcq ?? null),
            practical: absent ? null : (r?.practical ?? null),
            total: absent ? null : (r?.totalMarks ?? null),
            grade: absent ? 'ABSENT' : (r?.grade ?? null),
            gpa: absent ? null : (r?.gp ?? null)
          };
        })
      });
    }
    res.json({ examId, subjects: out });
  } catch (error: any) {
    console.error('Error fetching teacher results:', error);
    res.status(500).json({ error: 'Failed to fetch teacher results', details: error.message });
  }
});

// Exam Schedules (Routine)
app.get('/schedules', authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({
    examId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { examId } = parsed.data;

  const where: any = {};
  if (examId) where.examId = examId;

  const schedules = await prisma.examSchedule.findMany({
    where,
    include: { subject: true, class: true },
    orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }]
  });
  res.json(schedules);
});

app.post('/schedules', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    examId: z.string().min(1),
    classId: z.string().optional(),
    subjectId: z.string().min(1),
    date: z.string().min(1),
    startTime: z.string().min(1),
    endTime: z.string().min(1),
    fullMarks: z.number().min(0),
    passMarks: z.number().min(0).optional(),
    // Component full marks
    writtenFullMarks: z.number().min(0).default(0),
    mcqFullMarks: z.number().min(0).default(0),
    practicalFullMarks: z.number().min(0).default(0),
    // Component pass marks
    writtenPassMarks: z.number().min(0).default(0),
    mcqPassMarks: z.number().min(0).default(0),
    practicalPassMarks: z.number().min(0).default(0),
    gradingTypeId: z.string().optional().nullable(),
    roomNo: z.string().optional(),
    sortOrder: z.number().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { examId, classId, subjectId, date, startTime, endTime, fullMarks, passMarks, 
          writtenFullMarks, mcqFullMarks, practicalFullMarks,
          writtenPassMarks, mcqPassMarks, practicalPassMarks,
          gradingTypeId, roomNo, sortOrder } = parsed.data;

  // Validate component marks sum equals fullMarks
  const componentSum = writtenFullMarks + mcqFullMarks + practicalFullMarks;
  if (componentSum !== fullMarks) {
    return res.status(400).json({
      error: 'Component marks must sum to total full marks',
      details: {
        written: writtenFullMarks,
        mcq: mcqFullMarks,
        practical: practicalFullMarks,
        sum: componentSum,
        expected: fullMarks
      }
    });
  }

  // At least one component must be non-zero
  if (componentSum === 0) {
    return res.status(400).json({
      error: 'At least one component (written/mcq/practical) must have full marks > 0'
    });
  }

  const existing = await prisma.examSchedule.findFirst({
    where: { examId, subjectId, classId: classId || null }
  });

  // Resolve the grading template for this schedule (explicit override -> exam type).
  const resolvedGradingTypeId = resolveGradingTypeId(
    gradingTypeId,
    (await prisma.exam.findUnique({ where: { id: examId }, select: { typeId: true } }))?.typeId
  );

  // The grading template defines the mark scale for marks entry and grading.
  // When a template resolves, its totalFull (e.g. 50 for "50 Marks") is the
  // authoritative full marks â€” it overrides any client-supplied fullMarks that
  // assumed the wrong scale. Component full marks are re-derived to match.
  const tplTotalFull = await fetchTemplateTotalFull(resolvedGradingTypeId);
  const {
    fullMarks: effFull,
    writtenFullMarks: effWrittenFull,
    mcqFullMarks: effMcqFull,
    practicalFullMarks: effPracticalFull,
  } = tplTotalFull
    ? (() => {
        const cfg = defaultComponentConfig(tplTotalFull, {
          mcqIncluded: mcqFullMarks > 0,
          practicalIncluded: practicalFullMarks > 0,
        });
        return {
          fullMarks: tplTotalFull,
          writtenFullMarks: cfg.writtenFull,
          mcqFullMarks: cfg.mcqFull,
          practicalFullMarks: cfg.practicalFull,
        };
      })()
    : { fullMarks, writtenFullMarks, mcqFullMarks, practicalFullMarks };

  // Universal default grading scheme (100 / pass 33). When per-component pass
  // marks or the overall pass mark are not supplied, derive them from which
  // components are present so the resulting schedule follows the scheme.
  const defs = defaultComponentConfig(effFull, { mcqIncluded: effMcqFull > 0, practicalIncluded: effPracticalFull > 0 });
  const effPassMarks = (passMarks ?? 0) > 0 ? passMarks : defs.totalPass;
  const effWrittenPass = writtenPassMarks > 0 ? writtenPassMarks : defs.writtenPass;
  const effMcqPass = mcqPassMarks > 0 ? mcqPassMarks : defs.mcqPass;
  const effPracticalPass = practicalPassMarks > 0 ? practicalPassMarks : defs.practicalPass;

  // Capture the frozen grading snapshot at scheduling time. This is taken for
  // both the initial create and any subsequent upsert-by-update so that the
  // schedule always reflects the template as it was when it was (re)scheduled.
  const gradingSnapshot = await buildGradingSnapshot(resolvedGradingTypeId, effFull);

  const scheduleData = {
    date: new Date(date),
    startTime,
    endTime,
    fullMarks: effFull,
    passMarks: effPassMarks,
    writtenFullMarks: effWrittenFull,
    mcqFullMarks: effMcqFull,
    practicalFullMarks: effPracticalFull,
    writtenPassMarks: effWrittenPass,
    mcqPassMarks: effMcqPass,
    practicalPassMarks: effPracticalPass,
    gradingTypeId: resolvedGradingTypeId || null,
    gradingSnapshot: gradingSnapshot as any,
    roomNo: roomNo ?? null,
    sortOrder
  };

  if (existing) {
    const updated = await prisma.examSchedule.update({
      where: { id: existing.id },
      data: scheduleData
    });
    return res.json(updated);
  }

  const schedule = await prisma.examSchedule.create({
    data: {
      examId,
      classId: classId || null,
      subjectId,
      ...scheduleData
    }
  });
  res.json(schedule);
});

app.put('/schedules/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Start time must be in HH:mm format'),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'End time must be in HH:mm format'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { startTime, endTime } = parsed.data;
  if (endTime <= startTime) {
    return res.status(400).json({ error: 'End time must be after start time' });
  }

  try {
    const schedule = await prisma.examSchedule.update({
      where: { id: req.params.id },
      data: { startTime, endTime },
    });
    res.json(schedule);
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    console.error('Update schedule time error:', error);
    res.status(500).json({ error: 'Failed to update schedule time', details: error.message });
  }
});

app.delete('/schedules/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.examSchedule.delete({ where: { id } });
    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    console.error('Delete schedule error:', error);
    res.status(500).json({ error: 'Failed to delete schedule', details: error.message });
  }
});

// ---- Bulk schedule upsert (used by preset apply, manual fill, and drag reorder save) ----
app.post('/schedules/bulk', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      examId: z.string().min(1),
      items: z.array(z.object({
        id: z.string().optional(),
        classId: z.string().nullable().optional(),
        subjectId: z.string().min(1),
        date: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        fullMarks: z.number().optional(),
        passMarks: z.number().optional(),
        writtenFullMarks: z.number().optional(),
        mcqFullMarks: z.number().optional(),
        practicalFullMarks: z.number().optional(),
        writtenPassMarks: z.number().optional(),
        mcqPassMarks: z.number().optional(),
        practicalPassMarks: z.number().optional(),
        gradingTypeId: z.string().optional().nullable(),
        roomNo: z.string().optional(),
        sortOrder: z.number().optional(),
      })).min(1),
      replace: z.boolean().optional(), // if true, delete existing (examId, classId) rows not in items
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { examId, items, replace } = parsed.data;

    // Fail fast with precise 4xx responses instead of rolling the whole
    // transaction back and surfacing a generic 500.
    const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, typeId: true } });
    if (!exam) return res.status(404).json({ error: 'Exam not found. Create or select an exam before saving schedules.' });

    const subjectIds = Array.from(new Set(items.map((i) => i.subjectId)));
    const foundSubjects = await prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true } });
    const missingSubjects = subjectIds.filter((id) => !foundSubjects.some((s) => s.id === id));
    if (missingSubjects.length) {
      return res.status(400).json({ error: `Unknown subject(s): ${missingSubjects.join(', ')}. Refresh the page and try again.` });
    }
    const classIds = Array.from(new Set(items.map((i) => i.classId).filter((v): v is string => !!v)));
    if (classIds.length) {
      const foundClasses = await prisma.schoolClass.findMany({ where: { id: { in: classIds } }, select: { id: true } });
      const missingClasses = classIds.filter((id) => !foundClasses.some((c) => c.id === id));
      if (missingClasses.length) {
        return res.status(400).json({ error: `Unknown class(es): ${missingClasses.join(', ')}. Refresh the page and try again.` });
      }
    }
    const mismatched = items
      .map((item) => {
        if (item.fullMarks === undefined || item.writtenFullMarks === undefined) return null;
        const componentSum = (item.writtenFullMarks || 0) + (item.mcqFullMarks || 0) + (item.practicalFullMarks || 0);
        return componentSum > 0 && componentSum !== item.fullMarks ? `subject ${item.subjectId} (${componentSum} â‰  ${item.fullMarks})` : null;
      })
      .filter((v): v is string => !!v);
    if (mismatched.length) {
      return res.status(400).json({ error: `Component marks must sum to the total full marks: ${mismatched.join(', ')}.` });
    }

    const resultCount = await prisma.result.count({ where: { examId } });
    const existingSchedules = resultCount > 0
      ? await prisma.examSchedule.findMany({ where: { examId } })
      : [];

    if (replace && resultCount > 0) {
      return res.status(409).json({
        error: 'Cannot replace schedules after marks/results exist. Update the existing schedule rows instead.',
      });
    }

    // Resolve templates/snapshots once per grading type. Doing this inside the
    // per-row transaction loop caused 4 extra Neon round-trips per row and made
    // large schedule saves exceed Prisma's 5s interactive-transaction timeout.
    const gradingInfo = new Map<string, { totalFull: number | null; snapshot: any }>();
    for (const rawGradingTypeId of new Set(items.map((i) => i.gradingTypeId).filter((v): v is string => !!v))) {
      const resolvedId = resolveGradingTypeId(rawGradingTypeId, exam.typeId);
      if (!resolvedId) continue;
      const totalFull = await fetchTemplateTotalFull(resolvedId);
      const snapshot = totalFull ? await buildGradingSnapshot(resolvedId, totalFull) : null;
      gradingInfo.set(resolvedId, { totalFull, snapshot });
    }

    const saved: any[] = [];
    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        // Validate component sum if provided
        if (item.fullMarks !== undefined && item.writtenFullMarks !== undefined) {
          const componentSum = (item.writtenFullMarks || 0) + (item.mcqFullMarks || 0) + (item.practicalFullMarks || 0);
          if (componentSum !== item.fullMarks && componentSum > 0) {
            throw new HttpError(400, `Component marks sum (${componentSum}) must equal fullMarks (${item.fullMarks}) for subject ${item.subjectId}`);
          }
        }

        const data: any = {};
        if (item.date) data.date = new Date(item.date);
        if (item.startTime !== undefined) data.startTime = item.startTime;
        if (item.endTime !== undefined) data.endTime = item.endTime;
        if (item.fullMarks !== undefined) data.fullMarks = item.fullMarks;
        if (item.passMarks !== undefined) data.passMarks = item.passMarks;
        if (item.writtenFullMarks !== undefined) data.writtenFullMarks = item.writtenFullMarks;
        if (item.mcqFullMarks !== undefined) data.mcqFullMarks = item.mcqFullMarks;
        if (item.practicalFullMarks !== undefined) data.practicalFullMarks = item.practicalFullMarks;
        if (item.writtenPassMarks !== undefined) data.writtenPassMarks = item.writtenPassMarks;
        if (item.mcqPassMarks !== undefined) data.mcqPassMarks = item.mcqPassMarks;
        if (item.practicalPassMarks !== undefined) data.practicalPassMarks = item.practicalPassMarks;
        if (item.gradingTypeId !== undefined) data.gradingTypeId = item.gradingTypeId || null;
        if (item.roomNo !== undefined) data.roomNo = item.roomNo || null;
        if (item.sortOrder !== undefined) data.sortOrder = item.sortOrder;

        // Resolve the grading template for this item and let its totalFull define
        // the mark scale. When a template resolves, its totalFull (e.g. 50 for the
        // "50 Marks" template) overrides any client-supplied fullMarks/component
        // fulls that assumed the wrong scale, so marks entry, grading and display
        // all use the template's scale.
        const resolvedGradingTypeId = item.gradingTypeId
          ? resolveGradingTypeId(item.gradingTypeId, exam.typeId)
          : null;
        const templateInfo = resolvedGradingTypeId ? gradingInfo.get(resolvedGradingTypeId) : null;
        const tplTotalFull = templateInfo?.totalFull ?? null;
        if (tplTotalFull) {
          const cfg = defaultComponentConfig(tplTotalFull, {
            mcqIncluded: (data.mcqFullMarks ?? 0) > 0 || (item.mcqFullMarks ?? 0) > 0,
            practicalIncluded: (data.practicalFullMarks ?? 0) > 0 || (item.practicalFullMarks ?? 0) > 0,
          });
          data.fullMarks = tplTotalFull;
          data.writtenFullMarks = cfg.writtenFull;
          data.mcqFullMarks = cfg.mcqFull;
          data.practicalFullMarks = cfg.practicalFull;
        }

        // Fill omitted pass marks from the universal default scheme (100 / pass 33),
        // derived from which components are present.
        if (data.fullMarks !== undefined) {
          const defs = defaultComponentConfig(data.fullMarks, {
            mcqIncluded: (data.mcqFullMarks ?? 0) > 0,
            practicalIncluded: (data.practicalFullMarks ?? 0) > 0,
          });
          if (data.passMarks === undefined || data.passMarks == null) data.passMarks = defs.totalPass;
          if (data.writtenPassMarks === undefined || data.writtenPassMarks == null) data.writtenPassMarks = defs.writtenPass;
          if (data.mcqPassMarks === undefined || data.mcqPassMarks == null) data.mcqPassMarks = defs.mcqPass;
          if (data.practicalPassMarks === undefined || data.practicalPassMarks == null) data.practicalPassMarks = defs.practicalPass;
        }

        // Build a fresh frozen grading snapshot whenever a grading template id is
        // explicitly provided on the item (covers preset apply / manual fill that
        // re-schedules with a grading template). When none is provided here, keep
        // any existing snapshot below.
        const gradingSnapshot = templateInfo?.snapshot ?? null;
        if (gradingSnapshot) data.gradingSnapshot = gradingSnapshot;

        // Lock the mark scale once any result exists for this exam. Changing
        // fullMarks/components/pass/gradingType on an existing schedule after
        // marks have been entered would silently invalidate stored grades and
        // produce impossible totals (e.g. 519/450). Only timing/room/sort may
        // be edited after results exist.
        if (resultCount > 0) {
          const existing = existingSchedules.find((s) => {
            if (item.id && s.id === item.id) return true;
            return s.subjectId === item.subjectId && s.classId === (item.classId || null);
          });
          if (existing) {
            const scaleFields = ['fullMarks', 'writtenFullMarks', 'mcqFullMarks', 'practicalFullMarks', 'passMarks', 'gradingTypeId'] as const;
            const changed = scaleFields.some((f) => {
              const cur = existing[f];
              const neu = data[f];
              if (f === 'gradingTypeId') return (cur || null) !== (neu || null);
              return Number(cur || 0) !== Number(neu || 0);
            });
            if (changed) {
              throw new HttpError(409, `Cannot change mark scale for subject ${item.subjectId} after results exist. Unpublish and clear results first.`);
            }
          }
        }

        if (item.id) {
          try {
            const row = await tx.examSchedule.update({ where: { id: item.id }, data });
            saved.push(row);
            continue;
          } catch (e: any) {
            // Stale/deleted id â€” fall back to the idempotent upsert below.
            if (e?.code !== 'P2025') throw e;
          }
        }
        // idempotent upsert by (examId, subjectId, classId)
        const where = { examId, subjectId: item.subjectId, classId: item.classId || null };
        const existing = await tx.examSchedule.findFirst({ where });
        const base = { examId, subjectId: item.subjectId, classId: item.classId || null, ...data };
        if (existing) {
          // Preserve the existing snapshot when this item did not supply a grading template.
          const updateData = gradingSnapshot ? data : { ...data, gradingSnapshot: existing.gradingSnapshot ?? undefined };
          saved.push(await tx.examSchedule.update({ where: { id: existing.id }, data: updateData }));
        } else {
          saved.push(await tx.examSchedule.create({ data: base }));
        }
      }
      if (replace) {
        const keepIds = items.map((i) => i.id).filter(Boolean) as string[];
        const scopedClassIds = Array.from(new Set(items.map((i) => i.classId).filter((v): v is string => !!v)));
        const includesGlobal = items.some((i) => !i.classId);
        const scope = [
          ...(scopedClassIds.length ? [{ classId: { in: scopedClassIds } }] : []),
          ...(includesGlobal ? [{ classId: null }] : []),
        ];
        await tx.examSchedule.deleteMany({
          where: {
            examId,
            ...(scope.length ? { OR: scope } : {}),
            ...(keepIds.length ? { id: { notIn: keepIds } } : {}),
          }
        });
      }
    }, { timeout: 30000, maxWait: 10000 });

    res.json(saved);
  } catch (error: any) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'A schedule row already exists for one of the selected subjects in this class.' });
    }
    if (error?.code === 'P2003') {
      return res.status(400).json({ error: 'One of the selected subjects, classes or grading templates no longer exists. Refresh and try again.' });
    }
    if (error?.code === 'P2025') {
      return res.status(404).json({ error: 'One of the schedule rows no longer exists. Refresh and try again.' });
    }
    console.error('Bulk schedule error:', error);
    res.status(500).json({ error: 'Failed to save schedules', details: error.message });
  }
});

// ---- Reorder schedules (set sortOrder; optionally apply recalculated dates/times) ----
app.post('/schedules/reorder', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      items: z.array(z.object({
        id: z.string().min(1),
        sortOrder: z.number().optional(),
        date: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
      })).min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { items } = parsed.data;

    await prisma.$transaction(
      items.map((item) => {
        const data: any = {};
        if (item.sortOrder !== undefined) data.sortOrder = item.sortOrder;
        if (item.date) data.date = new Date(item.date);
        if (item.startTime !== undefined) data.startTime = item.startTime;
        if (item.endTime !== undefined) data.endTime = item.endTime;
        return prisma.examSchedule.update({ where: { id: item.id }, data });
      })
    );
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Reorder schedule error:', error);
    res.status(500).json({ error: 'Failed to reorder schedules', details: error.message });
  }
});

// ---- Exam Presets ----
app.get('/exam-presets', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const presets = await prisma.examPreset.findMany({
      orderBy: { name: 'asc' },
      include: {
        classes: {
          orderBy: { className: 'asc' },
          include: {
            subjects: {
              orderBy: { position: 'asc' },
              include: { presetClass: false },
            }
          }
        }
      }
    });
    res.json(presets);
  } catch (error: any) {
    console.error('Error fetching presets:', error);
    res.status(500).json({ error: 'Failed to fetch presets' });
  }
});

app.post('/exam-presets', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      name: z.string().min(1),
      durationHours: z.number().nullable().optional(),
      onePerDay: z.boolean().optional(),
      gapDays: z.number().nullable().optional(),
      gapAfterSubjects: z.array(z.object({ subjectId: z.string(), gapDays: z.number() })).optional(),
      excludedWeekdays: z.array(z.number()).optional(),
      defaultStartTime: z.string().nullable().optional(),
      defaultEndTime: z.string().nullable().optional(),
      classes: z.array(z.object({
        className: z.string().min(1),
        section: z.string().optional().nullable(),
        subjects: z.array(z.object({ subjectId: z.string().min(1), position: z.number(), fullMarks: z.number().optional(), passMarks: z.number().optional() })).optional(),
      })).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const d = parsed.data;

    const presetSubjectIds = Array.from(new Set((d.classes || []).flatMap((c) => (c.subjects || []).map((s) => s.subjectId))));
    if (presetSubjectIds.length) {
      const found = await prisma.subject.findMany({ where: { id: { in: presetSubjectIds } }, select: { id: true } });
      const missing = presetSubjectIds.filter((id) => !found.some((s) => s.id === id));
      if (missing.length) {
        return res.status(400).json({ error: `Unknown subject(s): ${missing.join(', ')}. Refresh the page and reselect them.` });
      }
    }

    const preset = await prisma.examPreset.create({
      data: {
        name: d.name,
        durationHours: d.durationHours,
        onePerDay: d.onePerDay ?? true,
        gapDays: d.gapDays,
        gapAfterSubjects: (d.gapAfterSubjects || []) as any,
        excludedWeekdays: (d.excludedWeekdays || [5, 6]) as any,
        defaultStartTime: d.defaultStartTime,
        defaultEndTime: d.defaultEndTime,
        classes: d.classes?.length ? {
          create: d.classes.map((c) => ({
            className: c.className,
            section: c.section || null,
            subjects: c.subjects?.length ? {
              create: c.subjects.map((s) => ({ subjectId: s.subjectId, position: s.position, fullMarks: s.fullMarks, passMarks: s.passMarks }))
            } : undefined,
          }))
        } : undefined,
      },
      include: { classes: { include: { subjects: true } } },
    });
    res.status(201).json(preset);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'This preset has duplicate class/section entries. Remove the duplicates and try again.' });
    }
    if (error?.code === 'P2003') {
      return res.status(400).json({ error: 'One of the selected subjects no longer exists. Refresh the page and reselect them.' });
    }
    console.error('Error creating preset:', error);
    res.status(500).json({ error: 'Failed to create preset', details: error.message });
  }
});

app.put('/exam-presets/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const schema = z.object({
      name: z.string().min(1).optional(),
      durationHours: z.number().optional().nullable(),
      onePerDay: z.boolean().optional(),
      gapDays: z.number().optional().nullable(),
      gapAfterSubjects: z.array(z.object({ subjectId: z.string(), gapDays: z.number() })).optional(),
      excludedWeekdays: z.array(z.number()).optional(),
      defaultStartTime: z.string().optional().nullable(),
      defaultEndTime: z.string().optional().nullable(),
      classes: z.array(z.object({
        id: z.string().optional(),
        className: z.string().min(1),
        section: z.string().optional().nullable(),
        subjects: z.array(z.object({ id: z.string().optional(), subjectId: z.string().min(1), position: z.number(), fullMarks: z.number().optional(), passMarks: z.number().optional() })).optional(),
      })).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const d = parsed.data;

    const existing = await prisma.examPreset.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Preset not found' });

    if (d.classes !== undefined) {
      const presetSubjectIds = Array.from(new Set(d.classes.flatMap((c) => (c.subjects || []).map((s) => s.subjectId))));
      if (presetSubjectIds.length) {
        const found = await prisma.subject.findMany({ where: { id: { in: presetSubjectIds } }, select: { id: true } });
        const missing = presetSubjectIds.filter((sid) => !found.some((s) => s.id === sid));
        if (missing.length) {
          return res.status(400).json({ error: `Unknown subject(s): ${missing.join(', ')}. Refresh the page and reselect them.` });
        }
      }
    }

    const preset = await prisma.$transaction(async (tx) => {
      const data: any = {};
      if (d.name !== undefined) data.name = d.name;
      if (d.onePerDay !== undefined) data.onePerDay = d.onePerDay;
      if (d.durationHours !== undefined) data.durationHours = d.durationHours;
      if (d.gapDays !== undefined) data.gapDays = d.gapDays;
      if (d.gapAfterSubjects !== undefined) data.gapAfterSubjects = d.gapAfterSubjects as any;
      if (d.excludedWeekdays !== undefined) data.excludedWeekdays = d.excludedWeekdays as any;
      if (d.defaultStartTime !== undefined) data.defaultStartTime = d.defaultStartTime;
      if (d.defaultEndTime !== undefined) data.defaultEndTime = d.defaultEndTime;

      if (d.classes !== undefined) {
        // rebuild classes+subjects
        await tx.examPresetClass.deleteMany({ where: { presetId: id } });
        if (d.classes.length) {
          await tx.examPresetClass.createMany({
            data: d.classes.map((c) => ({ presetId: id, className: c.className, section: c.section || null })),
          });
          const created = await tx.examPresetClass.findMany({ where: { presetId: id } });
          for (const c of d.classes) {
            const pc = created.find((x) => x.className === c.className && (x.section || null) === (c.section || null));
            if (pc && c.subjects?.length) {
              await tx.examPresetSubject.createMany({
                data: c.subjects.map((s) => ({ presetClassId: pc.id, subjectId: s.subjectId, position: s.position, fullMarks: s.fullMarks, passMarks: s.passMarks })),
              });
            }
          }
        }
      }

      return tx.examPreset.update({
        where: { id },
        data,
        include: { classes: { include: { subjects: { orderBy: { position: 'asc' } } } } },
      });
    });
    res.json(preset);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'This preset has duplicate class/section entries. Remove the duplicates and try again.' });
    }
    if (error?.code === 'P2003') {
      return res.status(400).json({ error: 'One of the selected subjects no longer exists. Refresh the page and reselect them.' });
    }
    console.error('Error updating preset:', error);
    res.status(500).json({ error: 'Failed to update preset', details: error.message });
  }
});

app.delete('/exam-presets/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    await prisma.examPreset.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ error: 'Preset not found â€” it may have already been deleted.' });
    }
    console.error('Error deleting preset:', error);
    res.status(500).json({ error: 'Failed to delete preset', details: error.message });
  }
});

// ---- Apply a preset to an exam to build/refresh its schedule ----
app.post('/exam-presets/apply', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      examId: z.string().min(1),
      presetId: z.string().min(1),
      selectedClasses: z.array(z.object({ className: z.string().min(1), section: z.string().optional().nullable() })).optional(),
      mode: z.enum(['auto', 'manual']).default('manual'),
      startDate: z.string().nullable().optional(),
      endDate: z.string().nullable().optional(),
      startTime: z.string().nullable().optional(),
      endTime: z.string().nullable().optional(),
      gapDays: z.number().optional(),
      excludedWeekdays: z.array(z.number()).optional(),
      onePerDay: z.boolean().optional(),
      replace: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const d = parsed.data;

    if (d.startDate && isNaN(new Date(d.startDate).getTime())) {
      return res.status(400).json({ error: `Invalid start date "${d.startDate}".` });
    }
    if (d.endDate && isNaN(new Date(d.endDate).getTime())) {
      return res.status(400).json({ error: `Invalid end date "${d.endDate}".` });
    }

    const preset = await prisma.examPreset.findUnique({
      where: { id: d.presetId },
      include: { classes: { include: { subjects: { orderBy: { position: 'asc' } } } } },
    });
    if (!preset) return res.status(404).json({ error: 'Preset not found' });

    const exam = await prisma.exam.findUnique({ where: { id: d.examId } });
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    // A preset may have been authored on a different mark scale than this exam's
    // grading template. Resolve the template once and normalise below so a
    // 50-mark exam never inherits 100-mark schedules (which would grade 40/50 as
    // 40/100 and drop the letter grade). Percentage-style templates
    // (totalFull >= 100) are scale-agnostic and keep the preset's own scale.
    const presetTemplateFull = await fetchTemplateTotalFull(exam.typeId);
    const presetGradingSnapshot = presetTemplateFull
      ? await buildGradingSnapshot(exam.typeId, presetTemplateFull)
      : null;
    const normalisePresetSubject = (subj: any) => {
      const oldFull = Number(subj.fullMarks) || 0;
      const newFull = presetTemplateFull && presetTemplateFull > 0 && presetTemplateFull < 100
        ? presetTemplateFull
        : oldFull;
      const scale = oldFull > 0 && newFull > 0 ? newFull / oldFull : 1;
      const oldPass = Number(subj.passMarks) || 0;
      const newPass = oldPass > 0 ? Math.round(oldPass * scale) : null;
      return { fullMarks: newFull || null, passMarks: newPass };
    };

    // resolve selected classes -> concrete SchoolClass ids (grade name + optional section)
    const targets = d.selectedClasses && d.selectedClasses.length
      ? d.selectedClasses
      : preset.classes.map((c) => ({ className: c.className, section: c.section }));

    const allClasses = await prisma.schoolClass.findMany();
    const resolved: Array<{ pcId: string; classId: string | null; className: string; section: string | null; subjects: any[] }> = [];
    for (const t of targets) {
      const pc = preset.classes.find((c) => c.className === t.className && (c.section || null) === (t.section || null));
      if (!pc) continue;
      const matches = allClasses.filter((c) => c.name === t.className && (!pc.section || c.section === pc.section));
      if (!matches.length) {
        resolved.push({ pcId: pc.id, classId: null, className: t.className, section: pc.section || null, subjects: [...pc.subjects] });
      } else {
        for (const m of matches) {
          resolved.push({ pcId: pc.id, classId: m.id, className: m.name, section: m.section || null, subjects: [...pc.subjects] });
        }
      }
    }

    // scheduling inputs (fallback to preset defaults)
    const gapDays = d.gapDays ?? preset.gapDays ?? 0;
    const excludedWeekdays = d.excludedWeekdays ?? (preset.excludedWeekdays as number[] ?? [5, 6]);
    const onePerDay = d.onePerDay ?? preset.onePerDay ?? true;
    const defaultStartTime = d.startTime ?? preset.defaultStartTime ?? '09:00';
    const defaultEndTime = d.endTime ?? preset.defaultEndTime ?? null;

    // Build output rows
    const built: any[] = [];
    for (const r of resolved) {
      let cursor = d.startDate ? new Date(d.startDate) : new Date(exam.startDate);
      let globalIdx = 0;
      for (const subj of r.subjects) {
        let date: Date | null = null;
        if (d.mode === 'auto' && d.startDate) {
          // walk to next allowed weekday
          let guard = 0;
          while (guard++ < 400) {
            const dayOfWeek = cursor.getDay();
            if (!excludedWeekdays.includes(dayOfWeek)) break;
            cursor = addDaysLocal(cursor, 1);
          }
          date = new Date(cursor);
          built.push({
            examId: d.examId,
            classId: r.classId,
            subjectId: subj.subjectId,
            date: date.toISOString(),
            startTime: defaultStartTime,
            endTime: defaultEndTime || `${addMinutesLocal(defaultStartTime, (preset.durationHours || 3) * 60)}`,
            ...normalisePresetSubject(subj),
            sortOrder: subj.position,
          });
          // advance cursor: one per day; after last subject or gap subject apply extra gap
          cursor = addDaysLocal(cursor, 1);
          const special = (preset.gapAfterSubjects as any[] || []).find((g) => g.subjectId === subj.subjectId);
          const after = special?.gapDays ?? 0;
          cursor = addDaysLocal(cursor, (onePerDay ? 1 : 0) + gapDays + after);
          globalIdx++;
        } else {
          built.push({
            examId: d.examId,
            classId: r.classId,
            subjectId: subj.subjectId,
            date: null,
            startTime: defaultStartTime,
            endTime: defaultEndTime || '',
            ...normalisePresetSubject(subj),
            sortOrder: subj.position,
          });
        }
      }
    }

    if (d.mode === 'auto') {
      if (d.replace) {
        const resultCount = await prisma.result.count({ where: { examId: d.examId } });
        if (resultCount > 0) {
          return res.status(409).json({ error: 'Cannot replace schedules after marks/results exist. Update the existing schedule instead.' });
        }
      }
      // persist computed rows (idempotent per exam/subject/class)
      const saved: any[] = [];
      await prisma.$transaction(async (tx) => {
        if (d.replace) {
          const targetClassIds = Array.from(new Set(resolved.map((r) => r.classId).filter((v): v is string => !!v)));
          const includesGlobal = resolved.some((r) => !r.classId);
          const scope = [
            ...(targetClassIds.length ? [{ classId: { in: targetClassIds } }] : []),
            ...(includesGlobal ? [{ classId: null }] : []),
          ];
          if (scope.length) {
            await tx.examSchedule.deleteMany({ where: { examId: d.examId, OR: scope } });
          }
        }
        for (const b of built) {
          const where = { examId: d.examId, subjectId: b.subjectId, classId: b.classId || null };
          const data = {
            date: new Date(b.date),
            startTime: b.startTime,
            endTime: b.endTime,
            fullMarks: b.fullMarks,
            passMarks: b.passMarks,
            sortOrder: b.sortOrder,
            ...(presetGradingSnapshot ? { gradingSnapshot: presetGradingSnapshot as any } : {}),
          };
          const existing = await tx.examSchedule.findFirst({ where });
          if (existing) saved.push(await tx.examSchedule.update({ where: { id: existing.id }, data }));
          else saved.push(await tx.examSchedule.create({ data: { ...where, ...data } }));
        }
      });
      const full = await prisma.examSchedule.findMany({
        where: { examId: d.examId },
        include: { subject: true },
        orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }],
      });
      return res.json({ mode: 'auto', items: built, saved: full });
    }

    res.json({ mode: 'manual', items: built });
  } catch (error: any) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error?.code === 'P2003') {
      return res.status(400).json({ error: 'One of the preset subjects or classes no longer exists. Refresh and try again.' });
    }
    console.error('Error applying preset:', error);
    res.status(500).json({ error: 'Failed to apply preset', details: error.message });
  }
});

// ---- Save as Preset from an existing exam schedule ----
app.post('/exam-presets/save-from-exam', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({ examId: z.string().min(1), name: z.string().trim().min(1, 'Preset name is required') });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { examId, name } = parsed.data;

    const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true } });
    if (!exam) return res.status(404).json({ error: 'Exam not found.' });

    const schedules = await prisma.examSchedule.findMany({
      where: { examId },
      include: { class: true, subject: true },
      orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }],
    });
    if (schedules.length === 0) {
      return res.status(400).json({ error: 'This exam has no schedule rows yet. Save the schedule before saving it as a preset.' });
    }

    // group by (class name, section)
    const groups: Record<string, { className: string; section: string | null; rows: any[] }> = {};
    for (const s of schedules) {
      const className = s.class?.name || '_all';
      const section = s.class?.section || null;
      const key = `${className}|${section || ''}`;
      (groups[key] ||= { className: className === '_all' ? '' : className, section, rows: [] }).rows.push(s);
    }

    const availableClasses = await prisma.schoolClass.findMany({ select: { name: true, section: true } });

    const preset = await prisma.examPreset.create({
      data: {
        name,
        durationHours: 3,
        onePerDay: true,
        gapAfterSubjects: [],
        excludedWeekdays: [5, 6],
        defaultStartTime: '09:00',
        defaultEndTime: null,
        classes: {
          create: Object.values(groups).map((g) => {
            // position = index within its own (class,date) ordering
            const sorted = [...g.rows].sort((a, b) =>
              (a.date.getTime() - b.date.getTime()) || ((a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
            const subjects = sorted.map((r, i) => ({
              subjectId: r.subjectId,
              position: i + 1,
              fullMarks: r.fullMarks,
              passMarks: r.passMarks,
            }));
            // If this group represents a grade that has no concrete class row yet, map to grade name; else className
            const className = g.className || availableClasses[0]?.name || '_all';
            return {
              className: className === '_all' ? 'All Classes' : className,
              section: g.section,
              subjects: { create: subjects },
            };
          }),
        },
      },
      include: { classes: { include: { subjects: true } } },
    });
    res.status(201).json(preset);
  } catch (error: any) {
    console.error('Error saving preset from exam:', error);
    res.status(500).json({ error: 'Failed to save preset', details: error.message });
  }
});

// date helpers for preset auto-scheduling
function addDaysLocal(d: Date, n: number): Date {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + n);
  return nd;
}
function addMinutesLocal(time: string, mins: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = (h || 0) * 60 + (m || 0) + mins;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

// Institute Profile
app.get('/institute', authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const { email } = req.query as any;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    let institute = await prisma.institute.findUnique({ where: { email } });
    if (!institute) {
      // Create default if not exists
      institute = await prisma.institute.create({
        data: {
          email,
          name: 'NexGrad Institute',
          targetLine: 'ESTD: 2012',
          currency: 'USD'
        }
      });
    }
    res.json(institute);
  } catch (error) {
    console.error('Error fetching institute profile:', error);
    res.status(500).json({ error: 'Failed to fetch institute profile' });
  }
});

app.post('/institute', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { email } = req.query as any;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const schema = z.object({
    name: z.string().optional(),
    logo: z.string().optional(),
    headmasterSignature: z.string().optional(),
    targetLine: z.string().optional(),
    schoolCode: z.string().optional(),
    emisCode: z.string().optional(),
    phone: z.string().optional(),
    website: z.string().optional(),
    address: z.string().optional(),
    country: z.string().optional(),
    currency: z.string().optional(),
    dueDay: z.number().int().min(1).max(31).optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const institute = await prisma.institute.upsert({
      where: { email },
      update: parsed.data,
      create: { ...parsed.data, email }
    });
    res.json(institute);
  } catch (error) {
    console.error('Error updating institute profile:', error);
    res.status(500).json({ error: 'Failed to update institute profile' });
  }
});

// Users
app.get('/users', authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(users);
});

// Teachers
app.get('/teachers', authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const teachers = await prisma.teacher.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(teachers);
});

app.post('/teachers', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string(),
    employeeId: z.string(),
    subject: z.string(),
    email: z.string().email(),
    phone: z.string(),
    avatar: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().optional()
    ),
    status: z.string().optional(),
    designation: z.string().optional(),
    joiningDate: z.preprocess(
      (v) => (typeof v === 'string' ? new Date(v) : undefined),
      z.date().optional()
    ),
    salary: z.number().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const teacher = await prisma.teacher.create({ data: parsed.data });
  res.status(201).json(teacher);
});

app.put('/teachers/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    name: z.string().optional(),
    employeeId: z.string().optional(),
    subject: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    avatar: z.string().optional().nullable(),
    status: z.string().optional(),
    designation: z.string().optional(),
    joiningDate: z.preprocess(
      (v) => (typeof v === 'string' ? new Date(v) : undefined),
      z.date().optional()
    ),
    salary: z.number().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const teacher = await prisma.teacher.update({ where: { id }, data: parsed.data });
  res.json(teacher);
});

app.delete('/teachers/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.$transaction([
      prisma.teacherSalary.deleteMany({ where: { teacherId: id } }),
      prisma.teacherAttendance.deleteMany({ where: { teacherId: id } }),
      prisma.teacher.delete({ where: { id } }),
    ]);
    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Teacher not found' });
    }
    console.error('Delete teacher error:', error);
    res.status(500).json({ error: 'Failed to delete teacher', details: error.message });
  }
});

// Fees
app.get('/fees', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const fees = await prisma.studentFee.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(fees);
});

app.post('/fees', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    studentId: z.string().min(1),
    feeType: z.string(),
    amount: z.number().positive(),
    discount: z.number().nonnegative().default(0),
    status: z.enum(['Paid', 'Due', 'Partial']).default('Due'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const fee = await prisma.studentFee.create({ data: parsed.data });
  res.status(201).json(fee);
});

app.put('/fees/:id', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    studentId: z.string().optional(),
    feeType: z.string().optional(),
    amount: z.number().optional(),
    discount: z.number().optional(),
    status: z.enum(['Paid', 'Due', 'Partial']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const fee = await prisma.studentFee.update({ where: { id }, data: parsed.data });
  res.json(fee);
});

// Retired: legacy StudentFee payments bypassed invoices and produced ledger income
// with no Payment row. All collection now goes through /payments against the
// Invoice bridge created for every category FeeRecord.
app.post('/fees/:id/pay', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Legacy fee payments are retired. Collect this fee against its invoice via POST /payments.',
  });
});

app.delete('/fees/:id', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.studentFee.delete({ where: { id } });
    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Fee record not found' });
    }
    console.error('Delete fee error:', error);
    res.status(500).json({ error: 'Failed to delete fee', details: error.message });
  }
});

// Salaries
app.get('/salaries', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const salaries = await prisma.teacherSalary.findMany({ orderBy: { paymentDate: 'desc' } });
  res.json(salaries);
});

app.post('/salaries/process', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    year: z.number().int(),
    month: z.number().int().min(0).max(11),
    teacherIds: z.array(z.string()).nonempty(),
    baseSalary: z.number().positive().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { year, month, teacherIds, baseSalary } = parsed.data;
  const paymentDate = new Date(year, month, 28);
  const teachers = await prisma.teacher.findMany({ where: { id: { in: teacherIds } } });
  const newRecords = await prisma.$transaction(
    teachers.map(t => {
      // Use teacher's actual salary, or fallback to provided baseSalary, or default to 3000
      const salary = t.salary ?? baseSalary ?? 3000;
      return prisma.teacherSalary.create({
        data: {
          teacherId: t.id,
          baseSalary: salary,
          bonus: 0,
          deductions: 0,
          netSalary: salary,
          paymentDate,
          status: 'Pending',
        },
      });
    })
  );
  res.status(201).json(newRecords);
});

app.post('/salaries/:id/pay', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await prisma.$transaction(async (tx) => {
    // Check if payment ledger entry already exists to prevent double-counting
    const existingLedger = await tx.ledgerEntry.findFirst({
      where: {
        ...ACTIVE_LEDGER,
        referenceInvoice: id,
        type: 'expense'
      }
    });
    if (existingLedger) {
      throw new HttpError(400, 'Payment has already been recorded');
    }

    const salary = await tx.teacherSalary.findUnique({ where: { id } });
    if (!salary) throw new HttpError(404, 'Salary record not found');

    // Conditional claim: concurrent pay requests can only create one ledger row.
    const claimed = await tx.teacherSalary.updateMany({
      where: { id, status: { not: 'Paid' } },
      data: { status: 'Paid' },
    });
    if (claimed.count === 0) throw new HttpError(400, 'Salary has already been paid');

    await tx.ledgerEntry.create({
      data: {
        type: 'expense',
        category: 'teacher_salary',
        amount: salary.netSalary,
        referenceInvoice: salary.id,
        date: salary.paymentDate
      }
    });
    await logAudit(tx, {
      action: 'salary.pay',
      entity: 'TeacherSalary',
      entityId: salary.id,
      actor: (req as any).user?.email ?? (req as any).user?.name,
      reason: `Teacher salary paid for ${salary.paymentDate.toISOString().slice(0, 10)}`,
      meta: { teacherId: salary.teacherId, amount: Number(salary.netSalary) },
    });
    return { ...salary, status: 'Paid' };
  });
  res.json(result);
});

app.delete('/salaries/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.teacherSalary.delete({ where: { id } });
    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Salary record not found' });
    }
    console.error('Delete salary error:', error);
    res.status(500).json({ error: 'Failed to delete salary', details: error.message });
  }
});

// Expenses
app.get('/expenses', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const expenses = await prisma.schoolExpense.findMany({ orderBy: { date: 'desc' } });
  res.json(expenses);
});

app.post('/expenses', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    category: z.string(),
    amount: z.number().positive(),
    date: z.string().transform((d) => new Date(d)),
    notes: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await prisma.$transaction(async (tx) => {
    const expense = await tx.schoolExpense.create({ data: parsed.data });
    await tx.ledgerEntry.create({
      data: {
        type: 'expense',
        // Store the category verbatim so it matches FinanceCategory names and
        // keeps the expense list and the ledger reports grouped identically.
        category: expense.category || '',
        amount: expense.amount,
        referenceInvoice: expense.id,
        date: expense.date,
        createdAt: expense.date
      }
    });
    await logAudit(tx, {
      action: 'expense.create',
      entity: 'SchoolExpense',
      entityId: expense.id,
      actor: (req as any).user?.email ?? (req as any).user?.name,
      reason: `Expense ${expense.category} of ${expense.amount}`,
      meta: { category: expense.category, amount: Number(expense.amount) },
    });
    return expense;
  });
  res.status(201).json(result);
});

app.put('/expenses/:id', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    category: z.string().optional(),
    amount: z.number().optional(),
    date: z.string().transform((d) => new Date(d)).optional(),
    notes: z.string().optional().nullable()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  
  const result = await prisma.$transaction(async (tx) => {
    const expense = await tx.schoolExpense.update({ where: { id }, data: parsed.data });

    // Mirror the edits onto the linked ledger row so reports never drift from
    // the expense list (category and amount both feed the breakdowns).
    const ledgerUpdate: any = {};
    if (parsed.data.amount !== undefined) ledgerUpdate.amount = parsed.data.amount;
    if (parsed.data.category !== undefined) ledgerUpdate.category = parsed.data.category;
    if (parsed.data.date !== undefined) ledgerUpdate.date = parsed.data.date;
    if (Object.keys(ledgerUpdate).length) {
      await tx.ledgerEntry.updateMany({ where: { referenceInvoice: id }, data: ledgerUpdate });
    }

    await logAudit(tx, {
      action: 'expense.update',
      entity: 'SchoolExpense',
      entityId: expense.id,
      actor: (req as any).user?.email ?? (req as any).user?.name,
      reason: 'Expense updated',
      meta: parsed.data as any,
    });

    return expense;
  });
  res.json(result);
});

app.delete('/expenses/:id', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  await prisma.$transaction(async (tx) => {
    // Find and delete the associated ledger entry
    await tx.ledgerEntry.deleteMany({
      where: { referenceInvoice: id }
    });
    await tx.schoolExpense.delete({ where: { id } });
    await logAudit(tx, {
      action: 'expense.delete',
      entity: 'SchoolExpense',
      entityId: id,
      actor: (req as any).user?.email ?? (req as any).user?.name,
      reason: 'Expense deleted',
    });
  });
  res.status(204).send();
});

// Classes
app.get('/classes', authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const classes = await prisma.schoolClass.findMany({
    orderBy: [{ name: 'asc' }, { section: 'asc' }],
    include: { teacher: { select: { id: true, name: true } } }
  });
  const counts = await Promise.all(
    classes.map(async (c) => {
      const count = await prisma.student.count({ where: { class: c.name, section: c.section } });
      return { ...c, teacher: c.teacher?.name ?? '', students: count };
    })
  );
  res.json(counts);
});

/**
 * GET /classes/:id/detail
 *
 * One aggregated payload for the class detail page: profile, staff, roster,
 * monthly attendance trend, exam standing, fee position and notices. Fetched in
 * a single request so the page is not built from six round trips.
 */
app.get('/classes/:id/detail', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const found = await prisma.schoolClass.findUnique({
      where: { id },
      include: {
        teacher: { select: { id: true, name: true, subject: true, email: true, phone: true, avatar: true, designation: true } },
        classSubjects: { include: { teacher: { select: { id: true, name: true, subject: true, avatar: true, designation: true } }, subject: { select: { id: true, name: true } } } },
      },
    });
    if (!found) return res.status(404).json({ error: 'Class not found' });

    const cls = found;
    const where = { class: cls.name, section: cls.section, status: ACTIVE_STUDENT_STATUS };

    // Exams hang off a class through ExamSchedule, not through Exam directly.
    const classExam = { schedules: { some: { classId: id } } };

    // The profile columns arrived in a later additive migration. Until it has
    // been applied the class still renders - it just shows these as unset.
    let profile = {} as Record<string, unknown>;
    try {
      const row = (await prisma.schoolClass.findUniqueOrThrow({
        where: { id },
        select: {
          room: true, floor: true, shift: true, startTime: true,
          endTime: true, weekDays: true, session: true, capacity: true,
        },
      })) as Record<string, unknown>;
      profile = row as Record<string, unknown>;
    } catch (err) {
      if (!isMissingColumn(err)) throw err;
    }

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);

    const [students, attendance, exams, results, invoices, payments, feeStructures, notices] =
      await Promise.all([
        prisma.student.findMany({
          where,
          orderBy: { roll: 'asc' },
          select: { id: true, name: true, roll: true, gender: true, admissionNo: true, avatar: true, guardianPhone: true },
        }),
        prisma.attendance.findMany({
          where: { student: where, date: { gte: sixMonthsAgo } },
          select: { date: true, status: true, studentId: true },
        }),
        prisma.exam.findMany({
          where: classExam,
          orderBy: { startDate: 'desc' },
          take: 8,
          select: { id: true, name: true, startDate: true, type: { select: { name: true } } },
        }),
        prisma.result.findMany({
          where: { student: where, exam: classExam },
          select: { written: true, mcq: true, practical: true, totalMarks: true, studentId: true },
        }),
        prisma.invoice.findMany({
          where: { student: where },
          select: { id: true, studentId: true, totalAmount: true, paidAmount: true, status: true, dueDate: true },
        }),
        prisma.payment.findMany({
          where: { status: 'active', invoice: { student: where } },
          select: { amount: true, date: true, invoice: { select: { studentId: true } } },
        }),
        prisma.feeStructure.findMany({
          where: { classId: id, isActive: true, frequency: 'monthly' },
          orderBy: { amount: 'asc' },
          take: 1,
          select: { amount: true },
        }),
        prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 6 }),
      ]);

    // --- Attendance, bucketed by month and per student -----------------
    const monthKey = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    type Bucket = { marked: number; present: number };
    const monthly = new Map<string, Bucket>();
    const perStudent = new Map<string, { marked: number; present: number }>();

    for (const row of attendance) {
      const status = normalizeAttendanceStatus(row.status);
      const key = monthKey(row.date);
      const bucket = monthly.get(key) ?? { marked: 0, present: 0 };
      bucket.marked++;
      if (status === 'Present' || status === 'Late') bucket.present++;
      monthly.set(key, bucket);

      const own = perStudent.get(row.studentId) ?? { marked: 0, present: 0 };
      own.marked++;
      if (status === 'Present' || status === 'Late') own.present++;
      perStudent.set(row.studentId, own);
    }

    const pctOf = (b: Bucket | undefined) =>
      b && b.marked > 0 ? Math.round((b.present / b.marked) * 100) : null;

    // Always six trailing months so the chart keeps a stable x-axis.
    const monthlyAttendance: Array<{ key: string; label: string; pct: number | null }> = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const key = monthKey(d);
      monthlyAttendance.push({
        key,
        label: d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
        pct: pctOf(monthly.get(key)),
      });
    }
    const currentMonth = monthKey(new Date());

    // --- Results ------------------------------------------------------
    // There is no obtainedMarks column: marks are split across the written,
    // mcq and practical components.
    const resultTotals = new Map<string, { obtained: number; total: number; n: number }>();
    for (const r of results) {
      const own = resultTotals.get(r.studentId) ?? { obtained: 0, total: 0, n: 0 };
      own.obtained += Number(r.written ?? 0) + Number(r.mcq ?? 0) + Number(r.practical ?? 0);
      own.total += Number(r.totalMarks ?? 0);
      own.n++;
      resultTotals.set(r.studentId, own);
    }
    const examAvgFor = (studentId: string) => {
      const t = resultTotals.get(studentId);
      if (!t || t.n === 0 || t.total <= 0) return null;
      return Math.round((t.obtained / t.total) * 100);
    };

    // --- Fees ---------------------------------------------------------
    const paidByStudent = new Map<string, number>();
    for (const p of payments) {
      const sid = p.invoice?.studentId;
      if (sid) paidByStudent.set(sid, (paidByStudent.get(sid) ?? 0) + Number(p.amount ?? 0));
    }
    const sum = (rows: typeof invoices, field: 'totalAmount' | 'paidAmount') =>
      rows.reduce((acc, r) => acc + Number(r[field] ?? 0), 0);
    const feesCollected = sum(invoices, 'paidAmount');
    const feesExpected = sum(invoices, 'totalAmount');

    const roster = students.map((s) => {
      const att = perStudent.get(s.id);
      const examAvg = examAvgFor(s.id);
      const paid = paidByStudent.get(s.id) ?? 0;
      return {
        id: s.id,
        name: s.name,
        roll: s.roll,
        gender: s.gender,
        admissionNo: s.admissionNo,
        avatar: s.avatar,
        guardianPhone: s.guardianPhone,
        attendancePct: pctOf(att),
        examAvg,
        feePaid: paid,
      };
    });

    const ranked = [...roster].sort((a, b) => (b.examAvg ?? -1) - (a.examAvg ?? -1));
    const topPerformers = ranked.filter((s) => s.examAvg !== null).slice(0, 3);
    const needsAttention = roster
      .filter((s) => s.attendancePct !== null && s.attendancePct < 85)
      .sort((a, b) => (a.attendancePct ?? 0) - (b.attendancePct ?? 0))
      .slice(0, 6);

    const withAttendance = roster.filter((s) => s.attendancePct !== null);
    const withMarks = roster.filter((s) => s.examAvg !== null);
    const avgExam =
      withMarks.length === 0
        ? null
        : Math.round(withMarks.reduce((a, s) => a + (s.examAvg ?? 0), 0) / withMarks.length);

    res.json({
      class: {
        id: cls.id,
        name: cls.name,
        section: cls.section,
        teacher: cls.teacher,
        ...profile,
        subjects: cls.classSubjects.map((cs) => ({
          subject: cs.subject?.name ?? '',
          teacher: cs.teacher
            ? { id: cs.teacher.id, name: cs.teacher.name, subject: cs.teacher.subject, avatar: cs.teacher.avatar, designation: cs.teacher.designation }
            : null,
        })),
      },
      monthlyFee: feeStructures[0] ? Number(feeStructures[0].amount) : null,
      stats: {
        total: students.length,
        male: students.filter((s) => s.gender?.toLowerCase() === 'male').length,
        female: students.filter((s) => s.gender?.toLowerCase() === 'female').length,
        attendancePct: withAttendance.length
          ? Math.round(withAttendance.reduce((a, s) => a + (s.attendancePct ?? 0), 0) / withAttendance.length)
          : null,
        examAvg: avgExam,
        feesCollected,
        feesExpected,
        feesOutstanding: Math.max(0, feesExpected - feesCollected),
        collectedThisMonth: payments
          .filter((p) => p.date && monthKey(new Date(p.date)) === currentMonth)
          .reduce((a, p) => a + Number(p.amount ?? 0), 0),
      },
      monthlyAttendance,
      students: roster,
      topPerformers,
      needsAttention,
      exams: exams.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type?.name ?? '',
        date: e.startDate,
      })),
      notices: notices.map((n) => ({
        id: n.id,
        title: n.title,
        content: n.content,
        author: n.author,
        role: n.role,
        target: n.target,
        createdAt: n.createdAt,
      })),
    });
  } catch (error) {
    console.error('Class detail error:', error);
    res.status(500).json({ error: 'Failed to load class detail' });
  }
});

app.post('/classes', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    section: z.string().min(1),
    teacherId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const cls = await prisma.schoolClass.create({ data: parsed.data });
  const students = await prisma.student.count({ where: { class: cls.name, section: cls.section } });
  res.status(201).json({ ...cls, students });
});

app.put('/classes/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    name: z.string().optional(),
    section: z.string().optional(),
    teacherId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const cls = await prisma.schoolClass.update({ where: { id }, data: parsed.data });
  const students = await prisma.student.count({ where: { class: cls.name, section: cls.section } });
  res.json({ ...cls, students });
});

app.delete('/classes/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.$transaction([
      prisma.admissionPackage.deleteMany({ where: { classId: id } }),
      prisma.examSchedule.deleteMany({ where: { classId: id } }),
      prisma.feeStructure.deleteMany({ where: { classId: id } }),
      prisma.classSubjectTeacher.deleteMany({ where: { classId: id } }),
      prisma.schoolClass.delete({ where: { id } }),
    ]);
    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Class not found' });
    }
    console.error('Delete class error:', error);
    res.status(500).json({ error: 'Failed to delete class', details: error.message });
  }
});

// Announcements (school-wide notice board)
const announcementTarget = z.enum(['All', 'Teachers', 'Students', 'Parents']);
const toAnnouncement = (a: any) => ({ ...a, date: a.createdAt });

app.get('/announcements', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (_req: Request, res: Response) => {
  try {
    const items = await prisma.announcement.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(items.map(toAnnouncement));
  } catch (error: any) {
    console.error('Fetch announcements error:', error);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

app.post('/announcements', authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({
    title: z.string().min(1),
    content: z.string().min(1),
    author: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    target: announcementTarget.optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const created = await prisma.announcement.create({
      data: {
        title: parsed.data.title,
        content: parsed.data.content,
        author: parsed.data.author ?? 'Admin',
        role: parsed.data.role ?? 'Admin',
        target: parsed.data.target ?? 'All',
      },
    });
    res.status(201).json(toAnnouncement(created));
  } catch (error: any) {
    console.error('Create announcement error:', error);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

app.put('/announcements/:id', authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    title: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    author: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    target: announcementTarget.optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const updated = await prisma.announcement.update({ where: { id }, data: parsed.data });
    res.json(toAnnouncement(updated));
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Announcement not found' });
    }
    console.error('Update announcement error:', error);
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

app.delete('/announcements/:id', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.announcement.delete({ where: { id } });
    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Announcement not found' });
    }
    console.error('Delete announcement error:', error);
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

// Subjects
app.get('/subjects', authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const subjects = await prisma.subject.findMany({ orderBy: [{ name: 'asc' }] });
  res.json(subjects);
});

app.post('/subjects', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    banglaName: z.string().optional().nullable(),
    code: z.string().min(1),
    type: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const subject = await prisma.subject.create({ data: parsed.data });
  res.status(201).json(subject);
});

app.put('/subjects/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    name: z.string().optional(),
    banglaName: z.string().optional().nullable(),
    code: z.string().optional(),
    type: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const subject = await prisma.subject.update({ where: { id }, data: parsed.data });
    res.json(subject);
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Subject not found' });
    }
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Subject code already exists' });
    }
    console.error('Update subject error:', error);
    res.status(500).json({ error: 'Failed to update subject', details: error.message });
  }
});

app.delete('/subjects/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.$transaction([
      prisma.examSchedule.deleteMany({ where: { subjectId: id } }),
      prisma.subject.delete({ where: { id } }),
    ]);
    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Subject not found' });
    }
    console.error('Delete subject error:', error);
    res.status(500).json({ error: 'Failed to delete subject', details: error.message });
  }
});

// Attendance
app.get('/attendance', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({
    class: z.string().optional(),
    section: z.string().optional(),
    date: z.string().min(1),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const className = parsed.data.class && parsed.data.class !== 'all' ? parsed.data.class : undefined;
  const section = parsed.data.section && parsed.data.section !== 'all' ? parsed.data.section : undefined;
  const { date } = parsed.data;
  // Standardize the day to the same UTC-midnight form used at save time.
  const day = utcMidnight(attendanceDayKey(String(date)));
  // Inactive/graduated/withdrawn students are not on roll, so they must never
  // appear on the register - otherwise they silently deflate attendance %.
  // Omitting class/section (or passing "all") returns the whole school.
  const students = await prisma.student.findMany({
    where: {
      status: ACTIVE_STUDENT_STATUS,
      ...(className ? { class: className } : {}),
      ...(section ? { section } : {}),
    },
    orderBy: [{ class: 'asc' }, { section: 'asc' }, { roll: 'asc' }],
    select: { id: true, name: true, roll: true, class: true, section: true },
  });
  const records = await prisma.attendance.findMany({
    where: { studentId: { in: students.map((s) => s.id) }, date: day },
  });
  const map = new Map(records.map((r) => [r.studentId, r.status]));
  const result = students.map((s) => ({
    studentId: s.id,
    studentName: s.name,
    roll: s.roll,
    class: s.class,
    section: s.section,
    // `marked` tells the register apart from a default: `status` falls back to
    // 'Present' for students with no saved row, so without this flag the UI
    // cannot tell "already marked present" from "never marked".
    marked: map.has(s.id),
    status: normalizeAttendanceStatus(map.get(s.id)) ,
  }));
  res.json(result);
});

// Tuition Fee Structures
app.get('/tuition/structures', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const items = await prisma.feeStructure.findMany({ where: { isActive: true }, include: { class: true } });
  res.json(items);
});

// Class -> assigned monthly tuition view (used by the fee assignment menu)
app.get('/tuition/class-fees', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const classes = await prisma.schoolClass.findMany({ orderBy: [{ name: 'asc' }, { section: 'asc' }] });
  const structures = await prisma.feeStructure.findMany({
    where: { isActive: true },
    include: { class: true },
  });
  const global = structures.find((s) => !s.classId);
  const rows = classes.map((c) => ({
    classId: c.id,
    className: c.name,
    section: c.section,
    structure:
      structures.find((s) => s.classId === c.id) ??
      structures.find((s) => s.class && s.class.name === c.name && s.class.section === c.section) ??
      (global ?? null),
  }));
  res.json({ rows, global: global ?? null });
});

app.post('/tuition/structures', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    classId: z.string().optional(),
    amount: z.number().positive(),
    frequency: z.string().default('monthly'),
    isActive: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const item = await prisma.feeStructure.create({ data: parsed.data });
  res.status(201).json(item);
});

app.put('/tuition/structures/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    name: z.string().optional(),
    classId: z.string().optional(),
    amount: z.number().positive().optional(),
    frequency: z.string().optional(),
    isActive: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const item = await prisma.feeStructure.update({ where: { id }, data: parsed.data });
  res.json(item);
});

app.delete('/tuition/structures/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.$transaction([
      prisma.studentFeeAssignment.deleteMany({ where: { feeStructureId: id } }),
      prisma.feeStructure.delete({ where: { id } }),
    ]);
    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Structure not found' });
    }
    console.error('Delete structure error:', error);
    res.status(500).json({ error: 'Failed to delete structure', details: error.message });
  }
});

// Student Fee Assignments
app.get('/tuition/assignments', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { studentId } = req.query as any;
  const where: any = {};
  if (studentId) where.studentId = String(studentId);
  const assignments = await prisma.studentFeeAssignment.findMany({ where, include: { student: true, feeStructure: true } });
  res.json(assignments);
});

app.post('/tuition/assignments', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    studentId: z.string().min(1),
    feeStructureId: z.string().min(1),
    discountPercent: z.number().min(0).max(100).default(0),
    customAmount: z.number().positive().optional(),
    startMonth: z.number().int().min(1).max(12),
    startYear: z.number().int(),
    endMonth: z.number().int().min(1).max(12).optional(),
    endYear: z.number().int().optional(),
    isActive: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const assignment = await prisma.studentFeeAssignment.create({ data: parsed.data });
  res.status(201).json(assignment);
});

app.put('/tuition/assignments/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    discountPercent: z.number().min(0).max(100).optional(),
    customAmount: z.number().positive().optional().nullable(),
    startMonth: z.number().int().min(1).max(12).optional(),
    startYear: z.number().int().optional(),
    endMonth: z.number().int().min(1).max(12).optional().nullable(),
    endYear: z.number().int().optional().nullable(),
    isActive: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = await prisma.studentFeeAssignment.update({ where: { id }, data: parsed.data as any });
  res.json(updated);
});

app.delete('/tuition/assignments/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  await prisma.studentFeeAssignment.delete({ where: { id } });
  res.status(204).send();
});

// Retired: monthly tuition is generated as a TUITION FeeRecord through
// POST /fees/generate. Keeping this route active would create a second billing
// system for the same student/month.
app.post('/tuition/generate-monthly', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Legacy tuition invoicing is retired. Generate the TUITION fee category via POST /fees/generate instead.',
  });
});
// Monthly Attendance Matrix
app.get('/attendance/matrix', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({
    classId: z.string().optional(),
    class: z.string().optional(),
    section: z.string().optional(),
    studentId: z.string().optional(),
    month: z.coerce.number().int().min(1).max(12),
    year: z.coerce.number().int()
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { classId, class: classNameParam, section: sectionParam, studentId, month, year } = parsed.data as any;

  // Resolve class + section
  let className = classNameParam as string | undefined;
  let section = sectionParam as string | undefined;

  if (studentId && (!className || !section)) {
    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (student) {
      className = student.class;
      section = student.section;
    }
  }

  if (classId && (!className || !section)) {
    const cls = await prisma.schoolClass.findUnique({ where: { id: classId } });
    if (!cls) return res.status(404).json({ error: 'Class not found' });
    className = cls.name;
    section = section ?? cls.section;
  }

  if (!className || !section) {
    return res.status(400).json({ error: 'class/section is required (or provide classId or studentId)' });
  }

  // Inactive/graduated students are off the roll: excluding them keeps their
  // unmarked days out of every present/absent tally and percentage.
  const students = await prisma.student.findMany({
    where: { class: className, section, status: ACTIVE_STUDENT_STATUS, ...(studentId ? { id: studentId } : {}) },
    orderBy: { roll: 'asc' },
    select: { id: true, name: true, roll: true }
  });

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => String(i + 1).padStart(2, '0'));

  const records = await prisma.attendance.findMany({
    where: {
      studentId: { in: students.map(s => s.id) },
      date: { gte: start, lt: end }
    },
    select: { studentId: true, date: true, status: true }
  });

  // Map to studentId -> day -> status letter
  const toLetter = (s: string) => {
    const v = s ? s.toLowerCase() : '';
    if (v.startsWith('pres')) return 'P';
    if (v.startsWith('abs')) return 'A';
    if (v.startsWith('lat')) return 'L';
    if (v.startsWith('lea')) return 'LV';
    return '-';
  };

  const matrix = new Map<string, Record<string, string>>();
  for (const r of records) {
    const day = String(new Date(r.date).getUTCDate()).padStart(2, '0');
    const m = matrix.get(r.studentId) ?? {};
    m[day] = toLetter(r.status);
    matrix.set(r.studentId, m);
  }

  const studentsOut = students.map((s) => {
    const rec = matrix.get(s.id) ?? {};
    let present = 0, absent = 0, late = 0, leave = 0;
    for (const d of days) {
      const st = rec[d];
      if (st === 'P') present++;
      else if (st === 'A') absent++;
      else if (st === 'L') late++;
      else if (st === 'LV') leave++;
    }
    // Percentage is over days the student was actually marked (Present +
    // Absent + Late + Leave), not every calendar day of the month. Dividing
    // by calendar days penalises a student for days attendance was never
    // taken (and for days before they were marked), producing percentages far
    // below the real rate. Students with no marked day report 0.
    const marked = present + absent + late + leave;
    const percentage = marked > 0 ? Math.round((present / marked) * 100) : 0;
    return {
      id: s.id,
      name: s.name,
      roll: s.roll,
      records: rec,
      present,
      absent,
      late,
      leave,
      marked,
      percentage
    };
  });

  // Daily totals
  const dailyTotals: Record<string, { present: number; absent: number; late: number; leave: number }> = {};
  for (const d of days) {
    let present = 0, absent = 0, late = 0, leave = 0;
    for (const s of studentsOut) {
      const st = (s.records as any)[d];
      if (st === 'P') present++;
      else if (st === 'A') absent++;
      else if (st === 'L') late++;
      else if (st === 'LV') leave++;
    }
    dailyTotals[d] = { present, absent, late, leave };
  }

  res.json({ days, students: studentsOut, dailyTotals });
});

// School-wide (or class-scoped) attendance overview.
// Powers the Daily / Weekly / Monthly stat blocks on the reports page.
//   ?date=YYYY-MM-DD                -> that single day
//   ?startDate=&endDate=            -> that range (weekly view)
//   ?month=&year=                   -> that calendar month (monthly view)
// `class` and `section` are OPTIONAL: omit them (or pass "all") for the whole
// school. Every figure is scoped to on-roll students, and `rate` divides by the
// number of students actually MARKED in the window - never by the roster - so
// unmarked days and off-roll students can't depress the percentage.
app.get('/attendance/overview', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({
    date: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
    year: z.coerce.number().int().optional(),
    class: z.string().optional(),
    section: z.string().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const q = parsed.data as any;

  try {
    // Resolve the window: explicit range wins, then single date, then month.
    let start: Date;
    let end: Date; // exclusive
    let mode: 'daily' | 'weekly' | 'monthly';

    const rangeStart = q.startDate ? new Date(String(q.startDate)) : null;
    const rangeEnd = q.endDate ? new Date(String(q.endDate)) : null;

    if (rangeStart && rangeEnd && !Number.isNaN(rangeStart.getTime()) && !Number.isNaN(rangeEnd.getTime())) {
      start = utcMidnight(attendanceDayKey(String(q.startDate)));
      end = utcMidnight(attendanceDayKey(String(q.endDate)));
      end.setUTCDate(end.getUTCDate() + 1);
      if (end <= start) end = new Date(start.getTime() + 86_400_000);
      mode = 'weekly';
    } else if (q.month && q.year) {
      start = new Date(Date.UTC(q.year, q.month - 1, 1));
      end = new Date(Date.UTC(q.year, q.month, 1));
      mode = 'monthly';
    } else if (q.date) {
      start = utcMidnight(attendanceDayKey(String(q.date)));
      end = new Date(start.getTime() + 86_400_000);
      mode = 'daily';
    } else {
      const today = utcMidnight(localDayKey(new Date()));
      start = today;
      end = new Date(today.getTime() + 86_400_000);
      mode = 'daily';
    }

    const className = q.class && q.class !== 'all' ? String(q.class) : undefined;
    const sectionName = q.section && q.section !== 'all' ? String(q.section) : undefined;
    const scopeIsSchool = !className && !sectionName;

    const rows = await prisma.attendance.findMany({
      where: {
        date: { gte: start, lt: end },
        student: {
          status: ACTIVE_STUDENT_STATUS,
          ...(className ? { class: className } : {}),
          ...(sectionName ? { section: sectionName } : {}),
        },
      },
      select: {
        studentId: true,
        date: true,
        status: true,
        student: { select: { class: true, section: true, roll: true } },
      },
    });

    // Head-count of students in scope (roster size, independent of marking).
    const activeStudentsInScope = await prisma.student.count({
      where: {
        status: ACTIVE_STUDENT_STATUS,
        ...(className ? { class: className } : {}),
        ...(sectionName ? { section: sectionName } : {}),
      },
    });

    type Bucket = { present: number; absent: number; late: number; leave: number; marked: number };
    const empty = (): Bucket => ({ present: 0, absent: 0, late: 0, leave: 0, marked: 0 });
    const totals = empty();
    const byDay = new Map<string, Bucket>();
    const byClass = new Map<string, Bucket & { students: Set<string> }>();

    for (const r of rows) {
      const status = normalizeAttendanceStatus(r.status);
      const dayKey = utcDayKeyOf(r.date);

      const day = byDay.get(dayKey) ?? empty();
      totals.marked++;
      day.marked++;
      const cls = byClass.get(`${r.student?.class ?? ''}|${r.student?.section ?? ''}`) ?? {
        ...empty(),
        students: new Set<string>(),
      };
      cls.marked++;
      cls.students.add(`${r.student?.class ?? ''}|${r.student?.section ?? ''}|${r.student?.roll ?? ''}`);

      if (status === 'Present') { totals.present++; day.present++; cls.present++; }
      else if (status === 'Absent') { totals.absent++; day.absent++; cls.absent++; }
      else if (status === 'Late') { totals.late++; day.late++; cls.late++; }
      else if (status === 'Leave') { totals.leave++; day.leave++; cls.leave++; }

      byDay.set(dayKey, day);
      byClass.set(`${r.student?.class ?? ''}|${r.student?.section ?? ''}`, cls);
    }

    // Fill every day in the window so the client can render gaps honestly.
    const days: Array<Bucket & { date: string; rate: number }> = [];
    for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = utcDayKeyOf(d);
      const b = byDay.get(key) ?? empty();
      days.push({ date: key, ...b, rate: b.marked > 0 ? Math.round((b.present / b.marked) * 100) : 0 });
    }

    const withRate = (b: Bucket) => ({
      ...b,
      rate: b.marked > 0 ? Math.round((b.present / b.marked) * 100) : 0,
    });

    res.json({
      mode,
      scope: scopeIsSchool ? 'school' : 'class',
      class: className ?? null,
      section: sectionName ?? null,
      startDate: utcDayKeyOf(start),
      endDate: utcDayKeyOf(new Date(end.getTime() - 86_400_000)),
      activeStudents: activeStudentsInScope,
      unmarked: Math.max(0, activeStudentsInScope - new Set(rows.map((r) => r.studentId)).size),
      totals: withRate(totals),
      days,
      byClass: Array.from(byClass.entries())
        .map(([key, b]) => {
          const [cls, sec] = key.split('|');
          return { class: cls, section: sec, studentsMarked: b.students.size, ...withRate(b) };
        })
        .sort((a, b) => a.class.localeCompare(b.class) || a.section.localeCompare(b.section)),
    });
  } catch (error: any) {
    console.error('Attendance overview error:', error);
    res.status(500).json({ error: 'Failed to load attendance overview' });
  }
});

// Teacher Attendance
app.get('/attendance/teachers', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({
    date: z.string().min(1),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { date } = parsed.data;
  const day = utcMidnight(attendanceDayKey(String(date)));

  const teachers = await prisma.teacher.findMany({ orderBy: { name: 'asc' } });
  const records = await prisma.teacherAttendance.findMany({
    where: { teacherId: { in: teachers.map((t) => t.id) }, date: day },
  });
  const map = new Map(records.map((r) => [r.teacherId, r.status]));

  const result = teachers.map((t) => ({
    teacherId: t.id,
    teacherName: t.name,
    status: normalizeAttendanceStatus(map.get(t.id)),
  }));
  res.json(result);
});

app.get('/store/products', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const items = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(items);
});

app.post('/store/products', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    category: z.string().optional(),
    purchasePrice: z.number().nonnegative(),
    sellingPrice: z.number().nonnegative(),
    // Opening balance for goods already on the shelf when a product is first
    // catalogued. Later stock changes go through purchases/sales only.
    openingStock: z.number().int().nonnegative().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { openingStock, ...fields } = parsed.data;
  const item = await prisma.product.create({
    data: { ...fields, currentStock: openingStock ?? 0 }
  });
  res.status(201).json(item);
});

app.put('/store/suppliers/:id', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    name: z.string().min(1).optional(),
    phone: z.string().optional(),
    address: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const item = await prisma.supplier.update({ where: { id }, data: parsed.data });
  res.json(item);
});

app.put('/store/products/:id', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    name: z.string().optional(),
    category: z.string().optional(),
    purchasePrice: z.number().nonnegative().optional(),
    sellingPrice: z.number().nonnegative().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const item = await prisma.product.update({ where: { id }, data: parsed.data });
  res.json(item);
});

app.get('/store/suppliers', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const items = await prisma.supplier.findMany({ orderBy: { name: 'asc' } });
  res.json(items);
});

app.post('/store/suppliers', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    address: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const item = await prisma.supplier.create({ data: parsed.data });
  res.status(201).json(item);
});

app.get('/store/purchases', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const items = await prisma.purchase.findMany({
    include: { items: true, supplier: true },
    orderBy: { purchaseDate: 'desc' }
  });
  res.json(items);
});

app.post('/store/purchases', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    supplierId: z.string().optional(),
    items: z.array(z.object({
      productId: z.string(),
      quantity: z.number().int().positive(),
      price: z.number().nonnegative(),
    })).min(1),
    purchaseDate: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { supplierId, items, purchaseDate } = parsed.data;
  const totalCost = items.reduce((s, it) => s + it.quantity * it.price, 0);

  const result = await prisma.$transaction(async (tx) => {
    const purchase = await tx.purchase.create({
      data: {
        supplierId: supplierId ?? null,
        totalCost,
        purchaseDate: purchaseDate ? new Date(purchaseDate) : undefined,
        items: { create: items.map(i => ({ productId: i.productId, quantity: i.quantity, price: i.price })) }
      },
      include: { items: true }
    });
    for (const it of items) {
      await tx.product.update({
        where: { id: it.productId },
        data: { currentStock: { increment: it.quantity } }
      });
    }
    await tx.ledgerEntry.create({
      data: {
        type: 'expense',
        category: 'store_purchase',
        amount: totalCost,
        referenceInvoice: purchase.id
      }
    });
    return purchase;
  });
  res.status(201).json(result);
});

app.get('/store/sales', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const items = await prisma.sale.findMany({
    include: { items: true, student: true },
    orderBy: { saleDate: 'desc' }
  });
  res.json(items);
});

app.post('/store/sales', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    studentId: z.string().optional(),
    items: z.array(z.object({
      productId: z.string(),
      quantity: z.number().int().positive(),
      price: z.number().nonnegative(),
    })).min(1),
    saleDate: z.string().optional(),
    paymentStatus: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { studentId, items, saleDate, paymentStatus } = parsed.data;
  const totalAmount = items.reduce((s, it) => roundMoney(money(it.quantity * it.price).plus(s)), money(0));

  const result = await prisma.$transaction(async (tx) => {
    // Ensure stock doesn't go negative
    for (const it of items) {
      const product = await tx.product.findUnique({ where: { id: it.productId } });
      if (!product || product.currentStock < it.quantity) {
        throw new HttpError(400, `Insufficient stock for product ${it.productId}. Available: ${product?.currentStock || 0}, Requested: ${it.quantity}`);
      }
    }

    const sale = await tx.sale.create({
      data: {
        studentId: studentId ?? null,
        totalAmount,
        paymentStatus: paymentStatus ?? 'paid',
        saleDate: saleDate ? new Date(saleDate) : undefined,
        items: { create: items.map(i => ({ productId: i.productId, quantity: i.quantity, price: i.price })) }
      },
      include: { items: true }
    });
    for (const it of items) {
      await tx.product.update({
        where: { id: it.productId },
        data: { currentStock: { decrement: it.quantity } }
      });
    }
    await tx.ledgerEntry.create({ data: { type: 'income', category: 'store_sale', amount: totalAmount, referenceInvoice: sale.id } });
    return sale;
  });
  res.status(201).json(result);
});

app.get('/store/inventory', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  try {
    const products = await prisma.product.findMany({ orderBy: { name: 'asc' } });
    res.json(products.map((p: any) => ({ id: p.id, name: p.name, stock: p.currentStock })));
  } catch (error: any) {
    console.error('Inventory error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

app.get('/store/reports/profit', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;

  const sales = await prisma.sale.findMany({
    where: from && to ? { saleDate: { gte: from, lte: to } } : undefined,
    include: { items: true }
  });
  const products = await prisma.product.findMany();
  const purchasePriceMap = new Map(products.map((p: any) => [p.id, Number(p.purchasePrice)]));
  const rows: any[] = [];
  for (const s of sales) {
    for (const it of s.items) {
      const revenue = Number(it.price) * Number(it.quantity);
      const cost = Number(purchasePriceMap.get(it.productId) ?? 0) * Number(it.quantity);
      const profit = revenue - cost;
      rows.push({ productId: it.productId, quantity: it.quantity, revenue, profit });
    }
  }
  const grouped: Record<string, { sold: number; revenue: number; profit: number }> = {};
  for (const r of rows) {
    if (!grouped[r.productId]) grouped[r.productId] = { sold: 0, revenue: 0, profit: 0 };
    grouped[r.productId].sold += r.quantity;
    grouped[r.productId].revenue += r.revenue;
    grouped[r.productId].profit += r.profit;
  }
  res.json(grouped);
});

app.post('/attendance/teachers/save', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({
    date: z.string().min(1),
    records: z.array(z.object({ teacherId: z.string().min(1), status: z.string().min(1) })).min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { date, records } = parsed.data;
  const day = new Date(String(date));

  const teachers = await prisma.teacher.findMany();
  const ids = new Set(teachers.map((t) => t.id));
  const toSave = records.filter((r) => ids.has(r.teacherId));

  await prisma.$transaction(
    toSave.map((r) =>
      prisma.teacherAttendance.upsert({
        where: { teacherId_date: { teacherId: r.teacherId, date: day } },
        update: { status: r.status },
        create: { teacherId: r.teacherId, date: day, status: r.status },
      })
    )
  );
  res.status(201).json({ ok: true });
});

/**
 * Attendance leave guard. Protects attendance records an APPROVED full-day
 * leave has synchronized: teachers marking a student Present/Absent/Late on a
 * day that leave covers must pass `override: true` (deliberate override) â€”
 * accidentally marking an on-leave student Absent is the error this prevents.
 * Explicitly marking 'Leave' never needs the override.
 */
async function assertAttendanceLeaveGuard(records: Array<{ studentId: string; status: string }>, day: Date, override: boolean): Promise<void> {
  const studentIds = Array.from(new Set(records.map((r) => r.studentId)));
  if (studentIds.length === 0) return;
  const leaves = await prisma.leave.findMany({
    where: {
      studentId: { in: studentIds },
      status: 'APPROVED',
      leaveType: 'FULL_DAY',
      startDate: { lte: day },
      endDate: { gte: day },
    },
  });
  if (leaves.length === 0) return;
  if (override) return;
  const students = await prisma.student.findMany({
    where: { id: { in: Array.from(new Set(leaves.map((l) => l.studentId))) } },
    select: { id: true, name: true },
  });
  const names = new Map(students.map((s) => [s.id, s.name]));
  const flagged: string[] = [];
  for (const r of records) {
    const leave = leaves.find((l) => l.studentId === r.studentId);
    if (!leave) continue;
    if ((r.status || '').toLowerCase() === 'leave') continue; // explicitly recording Leave is fine
    flagged.push(names.get(leave.studentId) || leave.studentId);
  }
  if (flagged.length === 0) return;
  throw new HttpError(
    409,
    `The following student(s) are on approved full-day leave for this date and must be marked "Leave": ${flagged.join(', ')}. This change was blocked to prevent accidental conflicts; authorized users can override it.`
  );
}

app.post('/attendance/save', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({
    class: z.string().min(1),
    section: z.string().min(1),
    date: z.string().min(1),
    records: z.array(z.object({ studentId: z.string().min(1), status: z.string().min(1) })).min(1),
    // Deliberate override for marking over an approved leave (reviewer duty).
    override: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { class: className, section, date, records } = parsed.data as any;
  const day = utcMidnight(attendanceDayKey(String(date)));
  try {
    await assertAttendanceLeaveGuard(records, day, Boolean(parsed.data.override));
  } catch (error: any) {
    return res.status(error.status || error.statusCode || 500).json({ error: error.message });
  }
    // Only on-roll students may be marked; silently drop records for anyone
    // who was made inactive between loading the register and saving.
    const students = await prisma.student.findMany({ where: { class: className, section, status: ACTIVE_STUDENT_STATUS } });
    const ids = new Set(students.map((s) => s.id));
    const toSave = records.filter((r: any) => ids.has(r.studentId));
    await prisma.$transaction(
      toSave.map((r: any) => {
        const status = normalizeAttendanceStatus(r.status);
        return prisma.attendance.upsert({
        where: { studentId_date: { studentId: r.studentId, date: day } },
        update: { status },
        create: { studentId: r.studentId, date: day, status },
      });
    })
  );
  res.status(201).json({ ok: true });
});

/**
 * DELETE /attendance/date?date=YYYY-MM-DD
 *
 * Clears every saved attendance row for a single day, school-wide. Used to wipe
 * a day that was marked against the wrong date and has to be redone.
 *
 * Admin only. Deliberately refuses any date other than the one supplied, and
 * reports how many rows it removed so the UI can confirm exactly what went.
 *
 * Student and teacher attendance are cleared together: the register page shows
 * both tabs, and wiping only students would leave the day looking half-cleared.
 */
app.delete('/attendance/date', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const requested = String(req.query.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
      return res.status(400).json({ error: 'date must use YYYY-MM-DD format' });
    }
    const start = utcMidnight(requested);
    if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== requested) {
      return res.status(400).json({ error: 'date is invalid' });
    }
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    const where = { date: { gte: start, lt: end } };

    const [studentCount, teacherCount] = await Promise.all([
      prisma.attendance.count({ where }),
      prisma.teacherAttendance.count({ where }),
    ]);

    // Nothing to do: report success rather than an error so a repeat click is
    // harmless rather than alarming.
    if (studentCount === 0 && teacherCount === 0) {
      return res.json({ date: requested, deleted: { students: 0, teachers: 0 } });
    }

    // One transaction: a half-deleted day is worse than no deletion at all.
    const [, deletedStudents] = await prisma.$transaction([
      prisma.teacherAttendance.deleteMany({ where }),
      prisma.attendance.deleteMany({ where }),
    ]);

    res.json({
      date: requested,
      deleted: { students: deletedStudents.count, teachers: teacherCount },
    });
  } catch (error: any) {
    console.error('Error deleting attendance for date:', error);
    res.status(500).json({ error: 'Failed to delete attendance' });
  }
});
// Admission Packages
app.get('/admission-packages', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { classId, session } = req.query;
  const where: any = { isActive: true };
  if (classId) where.classId = String(classId);
  if (session) where.session = String(session);

  const packages = await prisma.admissionPackage.findMany({
    where,
    include: { feeItems: true, class: true },
    orderBy: { createdAt: 'desc' }
  });
  res.json(packages);
});

app.post('/admission-packages', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string(),
    session: z.string(),
    classId: z.string(),
    description: z.string().optional(),
    feeItems: z.array(z.object({
      name: z.string(),
      amount: z.number().positive(),
      isMandatory: z.boolean().default(true)
    }))
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, session, classId, description, feeItems } = parsed.data;

  const pkg = await prisma.admissionPackage.create({
    data: {
      name,
      session,
      classId,
      description,
      feeItems: {
        create: feeItems
      }
    },
    include: { feeItems: true }
  });
  res.json(pkg);
});

app.put('/admission-packages/:id', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    name: z.string().optional(),
    session: z.string().optional(),
    classId: z.string().optional(),
    description: z.string().optional(),
    feeItems: z.array(z.object({
      id: z.string().optional(),
      name: z.string(),
      amount: z.number().positive(),
      isMandatory: z.boolean().default(true)
    })).optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, session, classId, description, feeItems } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.admissionPackage.update({
        where: { id },
        data: { name, session, classId, description }
      });

      if (feeItems) {
        await tx.admissionFeeItem.deleteMany({ where: { packageId: id } });
        await tx.admissionFeeItem.createMany({
          data: feeItems.map(item => ({
            packageId: id,
            name: item.name,
            amount: item.amount,
            isMandatory: item.isMandatory
          }))
        });
      }

      return await tx.admissionPackage.findUnique({
        where: { id },
        include: { feeItems: true, class: true }
      });
    });

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update package' });
  }
});

app.delete('/admission-packages/:id', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.admissionPackage.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete package' });
  }
});
// Replace your existing app.post('/students/admission', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), ...) with this:
app.post('/students/admission', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    student: z.object({
      name: z.string(),
      banglaName: z.string().optional(),
      dob: z.string().optional(),
      gender: z.string().optional(),
      bloodGroup: z.string().optional(),
      religion: z.string().optional(),
      photo: z.string().optional(), // base64
      phone: z.string().optional(),
      email: z.string().optional(),
      nationality: z.string().optional(),
      medicalNote: z.string().optional(),
      additionalNote: z.string().optional(),
      birthCertNo: z.string().optional(),
      siblingsCount: z.coerce.number().int().optional(), // Change: added z.coerce.number()
      admissionNo: z.union([z.literal(''), z.string().regex(/^\d{1,5}$/, 'Admission number must be 1-5 digits')]).optional(),
      classId: z.string(), // This is SchoolClass ID
      section: z.string().optional(),
      shift: z.string().optional(),
      roll: z.coerce.number().optional(), // Change: added z.coerce.number()
      academicYear: z.string().optional(),
    }),
    guardian: z.object({
      fatherName: z.string().optional(),
      fatherPhone: z.string().optional(),
      fatherOccupation: z.string().optional(),
      motherName: z.string().optional(),
      motherPhone: z.string().optional(),
      motherOccupation: z.string().optional(),
      guardianName: z.string().optional(),
      guardianPhone: z.string().optional(),
      guardianEmail: z.string().optional(),
      guardianRelation: z.string().optional(),
      guardianAddress: z.string().optional(),
      address: z.string().optional(), // legacy address field
    }),
    packageId: z.string()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    console.error('Admission validation error:', parsed.error.flatten());
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { student, guardian, packageId } = parsed.data;

  // Get package details
  const pkg = await prisma.admissionPackage.findUnique({
    where: { id: packageId },
    include: { feeItems: true, class: true }
  });

  if (!pkg) {
    console.error('Package not found:', packageId);
    return res.status(404).json({ error: 'Admission package not found', packageId });
  }

  // Start Transaction
  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create Student
      const className = pkg.class.name;
      const resolvedSection = student.section || pkg.class.section;

      // Resolve admission number: manual (max 5 digits) or auto-generated sequential (max 5 digits)
      let admissionNo: string;
      if (student.admissionNo && student.admissionNo.trim()) {
        admissionNo = `ADM-${String(student.admissionNo.trim()).padStart(5, '0')}`;
        const existing = await (tx as any).student.findUnique({ where: { admissionNo } });
        if (existing) {
          throw new Error(`Admission number ${admissionNo} already exists`);
        }
      } else {
        const rows = await (tx as any).student.findMany({
          select: { admissionNo: true }
        });
        let max = 0;
        for (const r of rows) {
          const m = r.admissionNo?.match(/(\d+)/);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        const next = Math.min(max + 1, 99999);
        admissionNo = `ADM-${String(next).padStart(5, '0')}`;
      }

      // Reject rolls already used in the same class + section
      if (student.roll) {
        const rollExists = await (tx as any).student.findFirst({
          where: {
            class: className,
            section: resolvedSection,
            roll: student.roll
          },
          select: { id: true }
        });
        if (rollExists) {
          throw new Error(`Roll ${student.roll} already exists in this class/section`);
        }
      }

      // A package with no payable fees (e.g. an existing student who already paid
      // their fees) has nothing to collect, so activate the student right away
      // instead of leaving them stuck in 'pending_payment'.
      const totalAmount = pkg.feeItems.reduce((sum, item) => sum.plus(item.amount), money(0));
      const fullyCovered = totalAmount.lte(0);

      const studentData: any = {
        name: student.name,
        banglaName: student.banglaName,
        dob: student.dob ? new Date(student.dob) : undefined,
        gender: student.gender || 'Other',
        bloodGroup: student.bloodGroup,
        religion: student.religion,
        avatar: student.photo,
        phone: student.phone,
        email: student.email,
        nationality: student.nationality,
        medicalNote: student.medicalNote,
        additionalNote: student.additionalNote,
        birthCertNo: student.birthCertNo,
        siblingsCount: student.siblingsCount ?? 0,
        class: className,
        section: resolvedSection,
        shift: student.shift,
        roll: student.roll || 0,
        academicYear: student.academicYear || pkg.session,
        fatherName: guardian.fatherName,
        motherName: guardian.motherName,
        guardianPhone: guardian.guardianPhone,
        guardianEmail: guardian.guardianEmail,
        address: guardian.address || guardian.guardianAddress,
        admissionNo,
        status: fullyCovered ? 'Active' : 'pending_payment'
      };

      const newStudent = await (tx as any).student.create({
        data: studentData
      });

      // 2. Create or update Guardian record
      await (tx as any).guardian.upsert({
        where: { studentId: newStudent.id },
        update: {
          fatherName: guardian.fatherName,
          fatherPhone: guardian.fatherPhone,
          fatherOccupation: guardian.fatherOccupation,
          motherName: guardian.motherName,
          motherPhone: guardian.motherPhone,
          motherOccupation: guardian.motherOccupation,
          guardianName: guardian.guardianName,
          guardianPhone: guardian.guardianPhone,
          guardianRelation: guardian.guardianRelation,
          guardianAddress: guardian.guardianAddress ?? guardian.address,
        },
        create: {
          studentId: newStudent.id,
          fatherName: guardian.fatherName,
          fatherPhone: guardian.fatherPhone,
          fatherOccupation: guardian.fatherOccupation,
          motherName: guardian.motherName,
          motherPhone: guardian.motherPhone,
          motherOccupation: guardian.motherOccupation,
          guardianName: guardian.guardianName,
          guardianPhone: guardian.guardianPhone,
          guardianRelation: guardian.guardianRelation,
          guardianAddress: guardian.guardianAddress ?? guardian.address,
        }
      });

       // 3. Create FeeRecord for admission (New Fee System)
       // First, ensure ADMISSION fee category exists
       let admissionCategory = await (tx as any).feeCategory.findUnique({
         where: { code: 'ADMISSION' }
       });

       if (!admissionCategory) {
         admissionCategory = await (tx as any).feeCategory.create({
           data: {
             code: 'ADMISSION',
             name: 'Admission Fee',
             description: 'One-time admission fee',
             isRecurring: false,
             frequency: 'once',
             isGeneratable: false,
             isActive: true
           }
         });
       }

       // Create FeeRecord for admission
       const admissionFeeRecord = await (tx as any).feeRecord.create({
         data: {
           studentId: newStudent.id,
           categoryId: admissionCategory.id,
           billingPeriod: `${new Date().getFullYear()}-ADM`,
            amount: totalAmount,
            assignmentAmount: totalAmount,
            source: 'package',
            status: fullyCovered ? 'waived' : 'due',
           notes: `Admission fee for package: ${pkg.name}`
         }
       });

       // Income is booked by the payment flow, when money is actually received.
       // Booking it here double-counted every admission that was later paid.

       // Update Student with admission FeeRecord link
       await (tx as any).student.update({
         where: { id: newStudent.id },
         data: {
           admissionFeeRecordId: admissionFeeRecord.id,
           admissionStatus: fullyCovered ? 'completed' : 'pending'
         }
       });

        // 4. Create Invoice (for backward compatibility)
        const admissionAcademicYear = academicYearForDate(new Date());
        const { invoiceNo } = await nextInvoiceNumber(tx, admissionAcademicYear);
        const invoice = await tx.invoice.create({
          data: {
            studentId: newStudent.id,
            type: 'admission',
            totalAmount,
            status: fullyCovered ? 'paid' : 'unpaid',
            billingMonth: `${new Date().getFullYear()}-ADM`,
            academicYear: admissionAcademicYear,
            invoiceNo,
            dueDate: new Date(),
            migrationFeeRecordId: admissionFeeRecord.id,
            items: {
              create: pkg.feeItems.map(item => ({
                name: item.name,
                amount: item.amount
              }))
            }
          },
          include: { items: true }
        });

        await logAudit(tx as any, {
          action: 'admission.create',
          entity: 'Student',
          entityId: newStudent.id,
          actor: (req as any).user?.email ?? (req as any).user?.name,
          reason: `Admission created with package ${pkg.name}`,
          meta: { invoiceId: invoice.id, invoiceNo, feeRecordId: admissionFeeRecord.id, amount: Number(totalAmount) },
        });

        return { student: newStudent, admissionFeeRecord, invoice };
    });

    res.json(result);
  } catch (error: any) {
    console.error('[POST /students/admission] Error:', error);
    res.status(500).json({ 
      error: 'Failed to process admission',
      details: error?.message || 'Unknown error'
    });
  }
});

// Payments
app.post('/payments', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    invoiceId: z.string(),
    amount: z.number().positive(),
    method: z.string(),
    transactionRef: z.string().optional(),
    receivedBy: z.string().optional(),
    date: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { invoiceId, amount, method, transactionRef, receivedBy, date } = parsed.data;
  const methodNormalized = (PAYMENT_METHODS as readonly string[]).includes(method) ? method : 'cash';
  const rawIdempotencyKey = req.headers['idempotency-key'];
  const idempotencyKey = typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey.trim() : '';
  if (idempotencyKey.length > 200) {
    return res.status(400).json({ error: 'Idempotency-Key must be at most 200 characters.' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      if (idempotencyKey) {
        const existing = await tx.payment.findUnique({ where: { idempotencyKey } });
        if (existing) return existing;
      }

      await lockInvoice(tx, invoiceId);
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: {
          id: true,
          studentId: true,
          totalAmount: true,
          paidAmount: true,
          status: true,
          type: true,
          academicYear: true,
          migrationFeeRecordId: true,
          // Joined in rather than fetched separately so the ledger entry below can be
          // attributed without another round trip inside the transaction.
          migrationFeeRecord: { select: { id: true, categoryId: true, billingPeriod: true } },
        },
      });
      if (!invoice) throw new HttpError(404, 'Invoice not found');

      const totalPaidAfter = money(invoice.paidAmount).plus(amount);
      if (totalPaidAfter.gt(invoice.totalAmount)) {
        throw new HttpError(400, `Payment exceeds remaining balance (can pay at most ${round2(Number(invoice.totalAmount) - Number(invoice.paidAmount))}).`);
      }

      const academicYear = invoice.academicYear ?? academicYearForDate(new Date());
      const { paymentNo } = await nextPaymentNumber(tx, academicYear);
      const paymentDate = date ? new Date(date) : new Date();

      const payment = await tx.payment.create({
        data: {
          invoiceId,
          amount: money(amount).toDecimalPlaces(2),
          method: methodNormalized,
          transactionRef,
          receivedBy,
          paymentNo,
          idempotencyKey: idempotencyKey || null,
          date: paymentDate,
          // Link back to the category fee record so its status can be derived.
          feeRecordId: invoice.migrationFeeRecordId ?? null,
        },
      });

await recalcInvoiceTx(tx, invoiceId);

       // Keep any linked FeeRecord status in step with real payments
       // (partial vs paid vs waived) rather than assuming a full settlement.
       if (invoice.migrationFeeRecordId) {
         await refreshRecordStatus(tx, invoice.migrationFeeRecordId);
       }

       // Handle student activation for admission fees
       if (invoice.type === 'admission') {
         const updated = await tx.invoice.findUnique({
           where: { id: invoiceId },
           select: { status: true },
         });

         if (updated?.status === 'paid') {
           // Update student status and admission status
           await tx.student.update({
             where: { id: invoice.studentId },
             data: {
               status: 'Active',
               admissionStatus: 'completed'
             },
           });
         }
       }

// A bridged invoice is a category fee, so tag the income row the same way the
        // admission flow does â€” otherwise category fee reports cannot attribute it.
        const bridgedRecord = invoice.migrationFeeRecord ?? null;

        await tx.ledgerEntry.create({
          data: {
            type: 'income',
            category: invoice.type === 'admission' ? 'admission_fee' : 'fee_collection',
            amount: money(amount).toDecimalPlaces(2),
            referenceInvoice: invoiceId,
            paymentId: payment.id,
            studentId: invoice.studentId,
            feeRecordId: bridgedRecord?.id ?? null,
            feeCategoryId: bridgedRecord?.categoryId ?? null,
            billingPeriod: bridgedRecord?.billingPeriod ?? null,
            date: paymentDate,
          },
        });

      await logAudit(tx, {
        action: 'payment.create',
        entity: 'Payment',
        entityId: paymentNo ?? payment.id,
        actor: receivedBy ?? (req as any).user?.email ?? (req as any).user?.name,
        reason: `Payment of ${amount} on invoice ${invoiceId}`,
        meta: { invoiceId, amount, method: methodNormalized },
      });

      return payment;
    }, PAYMENT_TX_OPTIONS);

    res.json(result);
  } catch (error: any) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error?.code === 'P2002' && idempotencyKey) {
      const existing = await prisma.payment.findUnique({ where: { idempotencyKey } });
      if (existing) return res.json(existing);
    }
    console.error('Payment error:', error);
    res.status(500).json({ error: 'Payment failed' });
  }
});

// Payments, voids and invoice creation each run several queries inside one interactive
// transaction. Prisma's default 5s budget is not enough for them over a remote pooler,
// where a single round trip can take the best part of a second, and the transaction
// aborting mid-way surfaces to the user as a bare 500. Take a payment on a slow link
// first and this fires regularly.
const MONEY_TX_OPTIONS = { timeout: 30000, maxWait: 15000 };
const PAYMENT_TX_OPTIONS = MONEY_TX_OPTIONS;

// Void / refund — payments are immutable. Reversing keeps the row and its audit
// trail, recalculates the invoice, and reverses the linked income entry. A void
// means "this receipt should never have existed"; a refund means the money was
// returned to the payer after being collected. They share the money movement but
// keep distinct statuses and reasons.
const reversePayment = async (
  paymentId: string,
  opts: { reason: string; actor?: string; mode: 'void' | 'refund' },
) => {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new HttpError(404, 'Payment not found');
    if (isVoided(payment)) {
      throw new HttpError(400, `Payment already ${payment.status === 'refunded' ? 'refunded' : 'voided'}`);
    }

    await lockInvoice(tx, payment.invoiceId);

    const reversedAt = new Date();
    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data:
        opts.mode === 'refund'
          ? {
              status: 'refunded',
              refundedAt: reversedAt,
              refundReason: opts.reason,
            }
          : {
              status: 'voided',
              voidedAt: reversedAt,
              voidedBy: opts.actor ?? null,
              voidReason: opts.reason,
            },
    });

    await recalcInvoiceTx(tx, payment.invoiceId);

    // A voided payment reduces what is settled, so the linked fee record
    // must be re-derived (it may fall back from 'paid' to 'partial'/'due').
    if (payment.feeRecordId) {
      await refreshRecordStatus(tx, payment.feeRecordId);
    }

    // A void cancels the original income rather than appending a second row.
    // Appending an expense left income counted in full *and* added an equal
    // expense, so every voided payment moved profit by twice its amount.
    // Flagging the row keeps it for audit and nets it out of all totals, which
    // exclude reversedAt != null.
    const reversed = await tx.ledgerEntry.updateMany({
      where: {
        type: 'income',
        paymentId: payment.id,
        reversedAt: null,
      },
      data: { reversedAt },
    });

    if (reversed.count === 0) {
      // No linked income row (e.g. income booked without a Payment row). Record
      // the shortfall so the gap is visible instead of silently skewing totals.
      console.warn(
        `[reversePayment] payment ${payment.id} (${payment.paymentNo ?? 'no paymentNo'}) ` +
          `${opts.mode === 'refund' ? 'refunded' : 'voided'} but no income ledger row was found to reverse`,
      );
    }

    await logAudit(tx, {
      action: opts.mode === 'refund' ? 'payment.refund' : 'payment.void',
      entity: 'Payment',
      entityId: payment.paymentNo ?? payment.id,
      actor: opts.actor,
      reason: opts.reason,
      meta: { invoiceId: payment.invoiceId, amount: payment.amount, reversal: true },
    });

    return { ...updatedPayment };
  }, MONEY_TX_OPTIONS);
};

app.post('/payments/:id/void', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({ reason: z.string().optional(), actor: z.string().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  const reason = parsed.success && parsed.data.reason ? parsed.data.reason : 'Voided';
  const actor = parsed.success ? parsed.data.actor : undefined;
  try {
    const result = await reversePayment(req.params.id, {
      reason,
      actor: actor ?? (req as any).user?.email ?? (req as any).user?.name,
      mode: 'void',
    });
    res.json(result);
  } catch (error: any) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    console.error('Void payment error:', error);
    res.status(500).json({ error: 'Failed to void payment' });
  }
});

app.post('/payments/:id/refund', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({ reason: z.string().optional(), actor: z.string().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  const reason = parsed.success && parsed.data.reason ? parsed.data.reason : 'Refund';
  const actor = parsed.success ? parsed.data.actor : undefined;
  try {
    const result = await reversePayment(req.params.id, {
      reason,
      actor: actor ?? (req as any).user?.email ?? (req as any).user?.name,
      mode: 'refund',
    });
    res.json(result);
  } catch (error: any) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    console.error('Refund payment error:', error);
    res.status(500).json({ error: 'Failed to refund payment' });
  }
});

app.get('/invoices', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { studentId, page = '1', limit = '20' } = req.query;
  const pageNum = Math.max(1, parseInt(String(page)) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(String(limit)) || 20));
  const skip = (pageNum - 1) * limitNum;

  const where: any = {};
  if (studentId) where.studentId = String(studentId);

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: { items: true, payments: true, student: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum
    }),
    prisma.invoice.count({ where })
  ]);

  res.json({
    data: invoices.map((inv: any) => {
      const balance = invoiceBalance(inv, inv.payments);
      return {
        ...inv,
        paid: netPaid(inv.payments).toNumber(),
        balance: balance.toNumber(),
        feeState: getFeeState(balance, inv.dueDate),
      };
    }),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) }
  });
});

app.post('/invoices/from-package', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    studentId: z.string(),
    packageId: z.string()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { studentId, packageId } = parsed.data;

  const pkg = await prisma.admissionPackage.findUnique({
    where: { id: packageId },
    include: { feeItems: true }
  });

  if (!pkg) return res.status(404).json({ error: 'Package not found' });

  const totalAmount = pkg.feeItems.reduce((sum, item) => sum.plus(item.amount), money(0));

  const invoice = await prisma.invoice.create({
    data: {
      studentId,
      type: 'package_fee',
      totalAmount,
      status: 'unpaid',
      items: {
        create: pkg.feeItems.map(item => ({
          name: item.name,
          amount: item.amount
        }))
      }
    },
    include: { items: true }
  });

  res.json(invoice);
});

// Create simple invoice (generic fee record) with optional immediate payment
app.post('/invoices/simple', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    studentId: z.string(),
    type: z.string().default('fee'),
    totalAmount: z.number().positive().optional(),
    items: z.array(z.object({ name: z.string(), amount: z.number().positive() })).min(1),
    initialPayment: z.number().min(0).optional().default(0),
    method: z.string().optional().default('cash'),
    billingMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'billingMonth must be YYYY-MM format').optional(),
    academicYear: z.string().optional(),
    date: z.string().optional(),
    dueDate: z.string().optional(),
    receivedBy: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { studentId, type, items, initialPayment, method, billingMonth, academicYear, date, dueDate, receivedBy } = parsed.data;

  if (String(type).toLowerCase() === 'tuition') {
    return res.status(410).json({
      error: 'Legacy tuition invoices are retired. Add a TUITION fee record or generate the TUITION category via /fees instead.',
    });
  }

  try {
    const explicitAcademicYear = normalizeAcademicYear(academicYear);
    if (academicYear && !explicitAcademicYear) {
      throw new HttpError(400, `Invalid academicYear "${academicYear}". Use format like "2026-27" or "2026".`);
    }

    const result = await prisma.$transaction(async (tx) => {
      // totalAmount is ALWAYS derived from items server-side — never trusted from the client.
      const computedTotal = items.reduce((s, i) => s.plus(money(i.amount)), money(0));
      if (computedTotal.lte(0)) throw new HttpError(400, 'Invoice total must be positive');

      const acYear = explicitAcademicYear ?? (billingMonth ? academicYearForMonth(Number(billingMonth.substring(0, 4)), Number(billingMonth.substring(5))) : academicYearForDate(date ? new Date(date) : new Date()));

      const invoiceDate = date ? new Date(date) : new Date();
      const { invoiceNo } = await nextInvoiceNumber(tx, acYear);

      const invoice = await tx.invoice.create({
        data: {
          studentId,
          type,
          totalAmount: roundMoney(computedTotal),
          status: 'unpaid',
          billingMonth: billingMonth ?? null,
          academicYear: acYear,
          invoiceNo,
          dueDate: dueDate ? new Date(dueDate) : null,
          createdAt: invoiceDate,
          items: {
            create: items.map(i => ({ name: i.name, amount: roundMoney(i.amount) }))
          }
        },
        include: { items: true, payments: true }
      });

      // Never accept an initial payment larger than the invoice itself.
      const capped = Math.min(initialPayment, Number(computedTotal));

      if (capped > 0) {
        const methodNormalized = (PAYMENT_METHODS as readonly string[]).includes(method) ? method : 'cash';
        const { paymentNo } = await nextPaymentNumber(tx, acYear);
        await tx.payment.create({
          data: {
            invoiceId: invoice.id,
            amount: money(capped).toDecimalPlaces(2),
            method: methodNormalized,
            receivedBy,
            paymentNo,
            date: invoiceDate,
          }
        });
        await recalcInvoiceTx(tx, invoice.id);
        await tx.ledgerEntry.create({
          data: {
            type: 'income',
            category: type === 'admission' ? 'admission_fee' : 'fee_collection',
            amount: money(capped).toDecimalPlaces(2),
            referenceInvoice: invoice.id,
            paymentId: (await tx.payment.findFirst({ where: { invoiceId: invoice.id }, select: { id: true } }))?.id ?? null,
            studentId,
            date: invoiceDate,
          }
        });
      }

      await logAudit(tx, {
        action: 'invoice.create',
        entity: 'Invoice',
        entityId: invoiceNo,
        actor: receivedBy ?? (req as any).user?.email ?? (req as any).user?.name,
        reason: capped > 0
          ? `Invoice created with initial payment ${capped}`
          : 'Invoice created',
        meta: { studentId, type, amount: Number(computedTotal), initialPayment: capped },
      });

      return await tx.invoice.findUnique({ where: { id: invoice.id }, include: { items: true, payments: true } });
    }, MONEY_TX_OPTIONS);
    res.status(201).json(result);
  } catch (e: any) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error('Create simple invoice error:', e);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

app.get('/invoices/:id', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  console.log(`[GET /invoices/:id] Fetching invoice with id: ${id}`);
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { items: true, payments: true, student: true }
  });
  console.log(`[GET /invoices/:id] Result:`, invoice ? 'Found' : 'NULL');
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const balance = invoiceBalance(invoice, invoice.payments);
  res.json({ ...invoice, paid: netPaid(invoice.payments).toNumber(), balance: balance.toNumber(), feeState: getFeeState(balance, invoice.dueDate) });
});

// Staff
app.get('/staff', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (_req: Request, res: Response) => {
  const staff = await prisma.staff.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(staff);
});

app.post('/staff', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    employeeId: z.string().min(1),
    designation: z.string().min(1),
    department: z.string().optional(),
    email: z.string().email().optional().or(z.literal('')),
    phone: z.string().min(1),
    avatar: z.string().optional(),
    status: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const staff = await prisma.staff.create({ data: parsed.data });
  res.status(201).json(staff);
});

app.put('/staff/:id', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const staff = await prisma.staff.update({ where: { id }, data: req.body });
  res.json(staff);
});

app.delete('/staff/:id', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  const { id } = req.params;
  await prisma.staff.delete({ where: { id } });
  res.status(204).send();
});

// Staff Salaries
app.get('/salaries/staff', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  const salaries = await prisma.staffSalary.findMany({
    include: { staff: true },
    orderBy: { paymentDate: 'desc' }
  });
  res.json(salaries.map((s: any) => ({
    ...s,
    staffName: s.staff.name,
    employeeId: s.staff.employeeId
  })));
});

app.post('/salaries/staff/process', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    staffIds: z.array(z.string()).min(1),
    month: z.number().min(1).max(12),
    year: z.number(),
    paymentDate: z.string().transform(d => new Date(d)),
    baseSalary: z.number().positive().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { staffIds, paymentDate, baseSalary } = parsed.data;

  const staff = await prisma.staff.findMany({ where: { id: { in: staffIds } } });
  const results = [];

  for (const s of staff) {
    // Use provided baseSalary or default to 1000
    // Note: Staff model doesn't have salary field, so we use API parameter or default
    const salary = baseSalary ?? 1000;
    const staffSalary = await prisma.staffSalary.create({
      data: {
        staffId: s.id,
        baseSalary: salary,
        netSalary: salary,
        paymentDate,
        status: 'Pending'
      }
    });
    results.push(staffSalary);
  }
  res.json(results);
});

app.post('/salaries/staff/:id/pay', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await prisma.$transaction(async (tx) => {
    // Check if payment ledger entry already exists to prevent double-counting
    const existingLedger = await tx.ledgerEntry.findFirst({
      where: {
        ...ACTIVE_LEDGER,
        referenceInvoice: id,
        type: 'expense'
      }
    });
    if (existingLedger) {
      throw new HttpError(400, 'Payment has already been recorded');
    }

    const salary = await tx.staffSalary.findUnique({ where: { id } });
    if (!salary) throw new HttpError(404, 'Salary record not found');

    // Conditional claim: concurrent pay requests can only create one ledger row.
    const claimed = await tx.staffSalary.updateMany({
      where: { id, status: { not: 'Paid' } },
      data: { status: 'Paid' },
    });
    if (claimed.count === 0) throw new HttpError(400, 'Salary has already been paid');

    await tx.ledgerEntry.create({
      data: {
        type: 'expense',
        category: 'staff_salary',
        amount: salary.netSalary,
        referenceInvoice: salary.id,
        date: salary.paymentDate
      }
    });
    await logAudit(tx, {
      action: 'salary.pay',
      entity: 'StaffSalary',
      entityId: salary.id,
      actor: (req as any).user?.email ?? (req as any).user?.name,
      reason: `Staff salary paid for ${salary.paymentDate.toISOString().slice(0, 10)}`,
      meta: { staffId: salary.staffId, amount: Number(salary.netSalary) },
    });
    return { ...salary, status: 'Paid' };
  });
  res.json(result);
});

// Ledger & Transactions
app.get('/finance/transactions', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { type, category, page = '1', limit = '20' } = req.query;
  const pageNum = Math.max(1, parseInt(String(page)) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(String(limit)) || 20));
  const skip = (pageNum - 1) * limitNum;

  const where: any = {};
  if (type) where.type = String(type);
  if (category) where.category = String(category);
  Object.assign(where, ACTIVE_LEDGER);

  const [entries, total] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum
    }),
    prisma.ledgerEntry.count({ where })
  ]);

  res.json({
    data: entries,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) }
  });
});

app.get('/finance/income', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { page = '1', limit = '20' } = req.query;
  const pageNum = Math.max(1, parseInt(String(page)) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(String(limit)) || 20));
  const skip = (pageNum - 1) * limitNum;

  const [entries, total] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { ...ACTIVE_LEDGER, type: 'income' },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum
    }),
    prisma.ledgerEntry.count({ where: { ...ACTIVE_LEDGER, type: 'income' } })
  ]);

  res.json({
    data: entries,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) }
  });
});

/* ---- Income / Expense categories (user-managed) ----
 * Transactions store their category as free text, so these categories are the
 * source of truth for the pickers and the management page. Renaming rewrites the
 * matching strings on historic rows so reports stay consistent.
 */
const financeCategoryTypeSchema = z.enum(['income', 'expense']);

// Legacy manual entries stored a normalised key (income: non-alphanumerics -> '_',
// expense: whitespace -> '_'). Match those too when rewriting after a rename.
const legacyCategoryKeys = (name: string): string[] =>
  Array.from(new Set([
    name,
    name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    name.toLowerCase().replace(/\s+/g, '_'),
  ]));

app.get('/finance/categories', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { type, includeInactive } = req.query;
    const where: any = {};
    if (type) {
      const parsed = financeCategoryTypeSchema.safeParse(String(type));
      if (!parsed.success) return res.status(400).json({ error: 'type must be "income" or "expense".' });
      where.type = parsed.data;
    }
    if (String(includeInactive) !== 'true') where.isActive = true;
    const categories = await prisma.financeCategory.findMany({
      where,
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
    res.json(categories);
  } catch (error: any) {
    console.error('Error fetching finance categories:', error);
    res.status(500).json({ error: 'Failed to load categories', details: error.message });
  }
});

app.post('/finance/categories', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      type: financeCategoryTypeSchema,
      name: z.string().trim().min(1, 'Category name is required'),
      description: z.string().trim().optional(),
      isActive: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const d = parsed.data;

    const created = await prisma.financeCategory.create({
      data: {
        type: d.type,
        name: d.name,
        description: d.description || null,
        isActive: d.isActive ?? true,
      },
    });
    res.status(201).json(created);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const name = String((req.body ?? {}).name ?? '').trim();
      return res.status(409).json({ error: `A category named "${name}" already exists for this type.` });
    }
    console.error('Error creating finance category:', error);
    res.status(500).json({ error: 'Failed to create category', details: error.message });
  }
});

app.put('/finance/categories/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const schema = z.object({
      name: z.string().trim().min(1, 'Category name is required').optional(),
      description: z.string().trim().nullable().optional(),
      isActive: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const d = parsed.data;

    const existing = await prisma.financeCategory.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Category not found.' });

    const updated = await prisma.$transaction(async (tx) => {
      const cat = await tx.financeCategory.update({
        where: { id },
        data: {
          ...(d.name !== undefined ? { name: d.name } : {}),
          ...(d.description !== undefined ? { description: d.description || null } : {}),
          ...(d.isActive !== undefined ? { isActive: d.isActive } : {}),
        },
      });
      const renamed = d.name !== undefined && d.name !== existing.name;
      if (renamed) {
        const keys = legacyCategoryKeys(existing.name);
        await tx.ledgerEntry.updateMany({
          where: { type: existing.type, category: { in: keys } },
          data: { category: cat.name },
        });
        if (existing.type === 'expense') {
          await tx.schoolExpense.updateMany({ where: { category: { in: keys } }, data: { category: cat.name } });
        }
      }
      return cat;
    });
    res.json(updated);
  } catch (error: any) {
    if (error?.code === 'P2002') return res.status(409).json({ error: 'Another category already uses that name.' });
    if (error?.code === 'P2025') return res.status(404).json({ error: 'Category not found.' });
    console.error('Error updating finance category:', error);
    res.status(500).json({ error: 'Failed to update category', details: error.message });
  }
});

app.delete('/finance/categories/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    await prisma.financeCategory.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ error: 'Category not found â€” it may already have been deleted.' });
    }
    console.error('Error deleting finance category:', error);
    res.status(500).json({ error: 'Failed to delete category', details: error.message });
  }
});

/**
 * POST /finance/income
 * Manual income entry. The Income page has always offered an "Add income" form,
 * but only the GET existed, so every submission 404'd and nothing was recorded.
 *
 * Writes an active ledger row (reversedAt stays null) so it is picked up by every
 * total, including the dashboard, without any special-casing.
 */
app.post('/finance/income', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { category, amount, date, notes, reference } = (req.body ?? {}) as {
    category?: string;
    amount?: unknown;
    date?: string;
    notes?: string;
    reference?: string;
  };

  const label = String(category ?? '').trim();
  if (!label) return res.status(400).json({ error: 'Category is required.' });

  let value: Prisma.Decimal;
  try {
    value = roundMoney(amount);
  } catch {
    return res.status(400).json({ error: 'Amount must be a number.' });
  }
  if (!value.gt(0)) return res.status(400).json({ error: 'Amount must be greater than 0.' });

  let when = new Date();
  if (date) {
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'Date is invalid.' });
    }
    when = parsed;
  }

  const entry = await prisma.ledgerEntry.create({
    data: {
      type: 'income',
      // Store the category label verbatim so it matches the managed
      // FinanceCategory names exactly (rename propagation relies on that).
      category: label,
      amount: value,
      date: when,
      referenceInvoice: reference ? String(reference) : null,
    },
  });

  res.status(201).json(entry);
});

/**
 * GET /finance/expenses
 * Ledger-backed expense list.
 *
 * The Expenses page used to read SchoolExpense directly, so it only ever showed
 * expenses created through that one form. Total Expenses on the dashboard sums
 * every 'expense' ledger row, which also includes salaries and store purchases,
 * so the page total and the dashboard total could never agree. Reading the same
 * ledger the totals use makes the two reconcile by construction.
 */
app.get('/finance/expenses', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { page = '1', limit = '20', category } = req.query;
  const pageNum = Math.max(1, parseInt(String(page)) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(String(limit)) || 20));
  const skip = (pageNum - 1) * limitNum;

  const where: any = { ...ACTIVE_LEDGER, type: 'expense' };
  if (category) where.category = String(category);

  const [entries, total, sum] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where,
      orderBy: { date: 'desc' },
      skip,
      take: limitNum,
    }),
    prisma.ledgerEntry.count({ where }),
    prisma.ledgerEntry.aggregate({ _sum: { amount: true }, where }),
  ]);

  res.json({
    data: entries,
    // Server-side total across every matching row, not just the current page.
    totalAmount: money(sum._sum.amount).toNumber(),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
});

// Financial Reports
app.get('/finance/reports/summary', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { from, to } = req.query;
  const where: any = {};
  const dateFilter: { gte?: Date; lt?: Date } = {};
  // Use half-open range [from, to) to exclude the day after 'to'. A one-sided
  // filter must still narrow the result; it must never silently return all time.
  if (from) dateFilter.gte = new Date(String(from));
  if (to) dateFilter.lt = new Date(String(to));
  if (Object.keys(dateFilter).length) where.date = dateFilter;

  const entries = await prisma.ledgerEntry.findMany({ where: { ...where, ...ACTIVE_LEDGER } });
  const income = entries.filter(e => e.type === 'income').reduce((s, e) => s.plus(e.amount), money(0));
  const expense = entries.filter(e => e.type === 'expense').reduce((s, e) => s.plus(e.amount), money(0));

  // Income and expense are totalled separately, so their per-category breakdowns
  // must be too. Merging them into one map let an expense such as
  // 'store_purchase' be reported as income purely because the caller guessed
  // from the category name.
  const bucket = (type: string) =>
    entries
      .filter(e => e.type === type)
      .reduce((acc: Record<string, number>, e) => {
        acc[e.category] = money(acc[e.category] ?? 0).plus(e.amount).toNumber();
        return acc;
      }, {});

  res.json({
    totalIncome: income,
    totalExpense: expense,
    netProfit: income.minus(expense),
    incomeByCategory: bucket('income'),
    expenseByCategory: bucket('expense'),
  });
});

// Fee Reports
app.get('/finance/reports/fees', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { page = '1', limit = '50' } = req.query;
  const pageNum = Math.max(1, parseInt(String(page)) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(String(limit)) || 50));
  const skip = (pageNum - 1) * limitNum;

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      include: { payments: true, student: true },
      orderBy: [{ createdAt: 'desc' }],
      skip,
      take: limitNum
    }),
    prisma.invoice.count()
  ]);

  const report = invoices.map(inv => {
    const paid = netPaid(inv.payments);
    const due = invoiceBalance(inv, inv.payments);
    return {
      id: inv.id,
      invoiceNo: inv.invoiceNo ?? null,
      academicYear: inv.academicYear ?? null,
      billingMonth: inv.billingMonth ?? null,
      studentName: inv.student.name,
      class: inv.student.class,
      section: inv.student.section,
      type: inv.type,
      total: inv.totalAmount,
      paid,
      due,
      balance: due,
      feeState: getFeeState(due, inv.dueDate),
      status: inv.status,
      date: inv.createdAt
    };
  });

  res.json({
    data: report,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) }
  });
});

// Fee summary (derived from invoices â€” never a parallel source of truth)
app.get('/finance/fees/summary', authMiddleware, authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  try {
    const today = new Date();
    const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const endMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);

    const [invoices, payments] = await Promise.all([
      prisma.invoice.findMany({ include: { payments: true } }),
      prisma.payment.findMany({ where: { date: { gte: startMonth, lt: endMonth } } }),
    ]);

    let totalOutstanding = money(0);
    let overdue = money(0);
    let dueSoon = money(0); // balance > 0, dueDate >= today
    let collectedToday = money(0);
    let collectedThisMonth = money(0);

    for (const inv of invoices) {
      const balance = invoiceBalance(inv, inv.payments);
      if (balance.lte(0)) continue;
      totalOutstanding = totalOutstanding.plus(balance);
      const state = getFeeState(balance, inv.dueDate, today);
      if (state === 'OVERDUE') overdue = overdue.plus(balance);
      else dueSoon = dueSoon.plus(balance);
    }

    for (const p of payments) {
      if (isVoided(p)) continue;
      const endOfToday = new Date(startToday.getTime() + 24 * 60 * 60 * 1000);
      if (p.date >= startMonth && p.date < endMonth) collectedThisMonth = collectedThisMonth.plus(p.amount);
      if (p.date >= startToday && p.date < endOfToday) collectedToday = collectedToday.plus(p.amount);
    }

    res.json({
      totalOutstanding: totalOutstanding.toNumber(),
      overdue: overdue.toNumber(),
      dueSoon: dueSoon.toNumber(),
      collectedToday: collectedToday.toNumber(),
      collectedThisMonth: collectedThisMonth.toNumber(),
      asOf: today,
    });
  } catch (error) {
    console.error('Fee summary error:', error);
    res.status(500).json({ error: 'Failed to compute fee summary' });
  }
});

// Grading System
app.get('/grading', authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  try {
    const { typeId } = req.query as any;
    const where: any = {};
    if (typeId) where.examTypeId = typeId;
    const systems = await prisma.gradingSystem.findMany({
      where,
      include: { examType: true },
      orderBy: { minPercent: 'desc' }
    });
    res.json(systems.map(s => ({
      ...s,
      examType: s.examType || { id: s.examTypeId, name: 'Unknown' }
    })));
  } catch (error: any) {
    console.error('Error fetching grading system:', error);
    res.status(500).json({ error: 'Failed to fetch grading system', details: error.message });
  }
});

app.post('/grading/bulk', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.array(z.object({
    id: z.string().optional(),
    grade: z.string(),
    minPercent: z.number(),
    maxPercent: z.number(),
    gp: z.number().default(0),
    status: z.string(),
    examTypeId: z.string().optional().nullable(),
    writtenPass: z.number().optional().nullable(),
    mcqPass: z.number().optional().nullable(),
    practicalPass: z.number().optional().nullable(),
    totalPass: z.number().optional().nullable(),
    writtenFull: z.number().optional().nullable(),
    mcqFull: z.number().optional().nullable(),
    practicalFull: z.number().optional().nullable(),
    totalFull: z.number().optional().nullable(),
  }));
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const incoming = parsed.data;
  const typeIds = [...new Set(incoming.map(i => i.examTypeId).filter(Boolean))] as string[];

  await prisma.$transaction(async (tx) => {
    if (typeIds.length > 0) {
      await tx.gradingSystem.deleteMany({
        where: { examTypeId: { in: typeIds } }
      });
    }
    await tx.gradingSystem.createMany({
      data: incoming.map(i => ({
        grade: i.grade,
        minPercent: i.minPercent,
        maxPercent: i.maxPercent,
        gp: i.gp,
        status: i.status,
        examTypeId: i.examTypeId || null,
        writtenPass: i.writtenPass,
        mcqPass: i.mcqPass,
        practicalPass: i.practicalPass,
        totalPass: i.totalPass,
        writtenFull: i.writtenFull,
        mcqFull: i.mcqFull,
        practicalFull: i.practicalFull,
        totalFull: i.totalFull
      }))
    });
  });

  res.json({ success: true });
});

// Get grading bands for a single grading template (for the editable bands UI).
app.get('/grading/:examTypeId/bands', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examTypeId } = req.params;
    const bands = await prisma.gradingSystem.findMany({
      where: { examTypeId },
      orderBy: { minPercent: 'asc' },
      select: {
        id: true,
        grade: true,
        minPercent: true,
        maxPercent: true,
        gp: true,
        status: true,
      },
    });
    res.json(bands);
  } catch (error: any) {
    console.error('Error fetching grading bands:', error);
    res.status(500).json({ error: 'Failed to fetch grading bands', details: error.message });
  }
});

// Save grading bands for a single grading template (atomic replace) with strict
// server-side validation. CRITICAL: changes apply ONLY to new schedules â€” existing
// schedules keep their frozen gradingSnapshot.
app.post('/grading/:examTypeId/bands', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examTypeId } = req.params;

    // Determine the grading scale (full marks) for this template. Percentage
    // templates use 100; marks-based templates (e.g. "50 Marks") use their own
    // reference full. Falls back to the existing bands' totalFull or 100.
    const existingBands = await prisma.gradingSystem.findMany({
      where: { examTypeId },
      select: { totalFull: true },
    });
    const scale = (existingBands[0]?.totalFull ?? 100) > 0 ? (existingBands[0]?.totalFull ?? 100) : 100;

    // Accept optional totalFull from the client to persist the grading scale
    // (e.g. 50 for a "50 Marks" template). When not supplied, preserve the
    // existing bands' totalFull so re-saves don't lose the scale.
    const bodySchema = z.object({
      bands: z.array(z.object({
        grade: z.string().min(1).max(20).trim(),
        minPercent: z.number().min(0).max(scale),
        maxPercent: z.number().min(0).max(scale),
        gp: z.number().min(0),
        status: z.enum(['PASS', 'FAIL']),
      })),
      totalFull: z.number().min(0).optional(),
    });
    // Support both { bands, totalFull } wrapper and plain array for backwards compat.
    let bands: z.infer<typeof bodySchema>['bands'];
    let totalFull: number | undefined;
    const rawBody = req.body;
    if (Array.isArray(rawBody)) {
      const arrSchema = z.array(z.object({
        grade: z.string().min(1).max(20).trim(),
        minPercent: z.number().min(0).max(scale),
        maxPercent: z.number().min(0).max(scale),
        gp: z.number().min(0),
        status: z.enum(['PASS', 'FAIL']),
      }));
      const arrParsed = arrSchema.safeParse(rawBody);
      if (!arrParsed.success) {
        return res.status(400).json({ error: 'Invalid band data', details: arrParsed.error.flatten() });
      }
      bands = arrParsed.data;
    } else {
      const parsed = bodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid band data', details: parsed.error.flatten() });
      }
      bands = parsed.data.bands;
      totalFull = parsed.data.totalFull;
    }

    const validation = validateGradingBands(bands, scale);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }

    // Ensure the template belongs to this exam type (or is a standalone template).
    const template = await prisma.examType.findUnique({ where: { id: examTypeId } });
    if (!template) {
      // Allow saving to a template only if an ExamType exists for it.
      return res.status(404).json({ error: 'Grading template (exam type) not found' });
    }

    // The totalFull to persist: prefer client-supplied, else keep existing, else
    // fall back to the derived scale.
    const persistedTotalFull = (totalFull != null && totalFull > 0)
      ? totalFull
      : (existingBands[0]?.totalFull ?? scale);

    await prisma.$transaction(async (tx) => {
      await tx.gradingSystem.deleteMany({ where: { examTypeId } });
      await tx.gradingSystem.createMany({
        data: bands.map((b) => ({
          examTypeId,
          grade: b.grade,
          minPercent: b.minPercent,
          maxPercent: b.maxPercent,
          gp: b.gp,
          status: b.status,
          totalFull: persistedTotalFull,
        })),
      });
    });

    res.json({
      success: true,
      message: 'Grading bands updated. Changes apply to new schedules only; existing schedules keep their saved grading.',
      warnings: validation.warnings,
    });
  } catch (error: any) {
    console.error('Error saving grading bands:', error);
    res.status(500).json({ error: 'Failed to save grading bands', details: error.message });
  }
});

// Fee Particulars
app.get('/fee-particulars', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const { target } = req.query;
  const where: any = {};
  if (target) where.target = String(target);

  const particulars = await prisma.feeParticular.findMany({
    where,
    orderBy: { createdAt: 'asc' }
  });
  res.json(particulars);
});

app.post('/fee-particulars/bulk', authMiddleware, authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  const schema = z.object({
    target: z.string(),
    particulars: z.array(z.object({
      id: z.string().optional(),
      label: z.string(),
      amount: z.number().nullable(),
      isFixed: z.boolean()
    }))
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { target, particulars } = parsed.data;

  await prisma.$transaction([
    prisma.feeParticular.deleteMany({ where: { target } }),
    prisma.feeParticular.createMany({
      data: particulars.map(p => ({
        label: p.label,
        amount: p.amount,
        isFixed: p.isFixed,
        target
      }))
    })
  ]);

  res.json({ success: true });
});

// Teacher Login Management
app.get('/teachers/logins', authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  try {
    const logins = await prisma.teacherLogin.findMany({
      include: { teacher: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(logins);
  } catch (error) {
    console.error('Error fetching teacher logins:', error);
    res.status(500).json({ error: 'Failed to fetch teacher logins' });
  }
});

app.post('/teachers/logins', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { teacherId, username, password, role, status } = req.body;

    const login = await prisma.teacherLogin.create({
      data: {
        teacherId,
        username,
        password,
        role: role || 'Teacher',
        status: status || 'Active',
      },
    });

    res.status(201).json(login);
  } catch (error) {
    console.error('Error creating teacher login:', error);
    res.status(500).json({ error: 'Failed to create teacher login' });
  }
});

app.put('/teachers/logins/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { password, status } = req.body;

    const login = await prisma.teacherLogin.update({
      where: { id },
      data: {
        ...(password && { password }),
        ...(status && { status }),
      },
    });

    res.json(login);
  } catch (error) {
    console.error('Error updating teacher login:', error);
    res.status(500).json({ error: 'Failed to update teacher login' });
  }
});

app.delete('/teachers/logins/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.teacherLogin.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting teacher login:', error);
    res.status(500).json({ error: 'Failed to delete teacher login' });
  }
});

// ---------------------------------------------------------------
// Teacher Permissions Management
// ---------------------------------------------------------------
app.get('/permissions', authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  try {
    const teachers = await prisma.teacher.findMany({
      orderBy: { name: 'asc' },
      include: { permission: true }
    });
    const classes = await prisma.schoolClass.findMany({
      orderBy: [{ name: 'asc' }, { section: 'asc' }]
    });

    res.json({
      teachers: teachers.map((t: any) => ({
        id: t.id,
        name: t.name,
        email: t.email,
        subject: t.subject,
        designation: t.designation,
        status: t.status,
        permission: t.permission || null
      })),
      classes: classes.map((c: any) => ({ id: c.id, name: c.name, section: c.section }))
    });
  } catch (error) {
    console.error('Error fetching permissions:', error);
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
});

app.put('/permissions/:teacherId', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { teacherId } = req.params;
    const schema = z.object({
      attendanceMode: z.enum(['none', 'assigned', 'all', 'specific']),
      attendanceClassIds: z.array(z.string()),
      marksMode: z.enum(['none', 'assigned', 'all', 'specific']),
      marksClassIds: z.array(z.string())
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } });
    if (!teacher) return res.status(404).json({ error: 'Teacher not found' });

    const permission = await prisma.teacherPermission.upsert({
      where: { teacherId },
      update: parsed.data,
      create: { teacherId, ...parsed.data }
    });

    res.json(permission);
  } catch (error) {
    console.error('Error updating permissions:', error);
    res.status(500).json({ error: 'Failed to update permissions' });
  }
});

// ---------------------------------------------------------------
// Class-Subject-Teacher Assignments (which teacher teaches which subject in which class)
// ---------------------------------------------------------------
app.get('/class-subject-teachers', authMiddleware, checkRole(['Admin']), async (_req: Request, res: Response) => {
  try {
    const [assignments, teachers, classes, subjects] = await Promise.all([
      prisma.classSubjectTeacher.findMany({
        orderBy: [{ class: { name: 'asc' } }, { class: { section: 'asc' } }, { subject: { name: 'asc' } }],
        include: { teacher: true, class: true, subject: true }
      }),
      prisma.teacher.findMany({ orderBy: { name: 'asc' } }),
      prisma.schoolClass.findMany({ orderBy: [{ name: 'asc' }, { section: 'asc' }] }),
      prisma.subject.findMany({ orderBy: { name: 'asc' } })
    ]);

    res.json({
      assignments: assignments.map((a: any) => ({
        id: a.id,
        teacherId: a.teacherId,
        classId: a.classId,
        subjectId: a.subjectId,
        teacherName: a.teacher?.name || '',
        className: a.class?.name || '',
        classSection: a.class?.section || '',
        subjectName: a.subject?.name || ''
      })),
      teachers: teachers.map((t: any) => ({ id: t.id, name: t.name, subject: t.subject })),
      classes: classes.map((c: any) => ({ id: c.id, name: c.name, section: c.section })),
      subjects: subjects.map((s: any) => ({ id: s.id, name: s.name, code: s.code }))
    });
  } catch (error) {
    console.error('Error fetching class-subject-teachers:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

app.post('/class-subject-teachers', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      teacherId: z.string().min(1),
      classId: z.string().min(1),
      subjectId: z.string().min(1)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { teacherId, classId, subjectId } = parsed.data;

    const [teacher, cls, subject] = await Promise.all([
      prisma.teacher.findUnique({ where: { id: teacherId } }),
      prisma.schoolClass.findUnique({ where: { id: classId } }),
      prisma.subject.findUnique({ where: { id: subjectId } })
    ]);
    if (!teacher) return res.status(404).json({ error: 'Teacher not found' });
    if (!cls) return res.status(404).json({ error: 'Class not found' });
    if (!subject) return res.status(404).json({ error: 'Subject not found' });

    // One teacher per (class, subject) â€” upsert so reassigning just updates the teacher.
    const assignment = await prisma.classSubjectTeacher.upsert({
      where: { classId_subjectId: { classId, subjectId } },
      update: { teacherId },
      create: { teacherId, classId, subjectId }
    });

    res.status(201).json(assignment);
  } catch (error) {
    console.error('Error creating class-subject-teacher:', error);
    res.status(500).json({ error: 'Failed to create assignment' });
  }
});

app.put('/class-subject-teachers/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const schema = z.object({
      teacherId: z.string().min(1),
      classId: z.string().min(1),
      subjectId: z.string().min(1)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const existing = await prisma.classSubjectTeacher.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Assignment not found' });

    const assignment = await prisma.classSubjectTeacher.update({
      where: { id },
      data: parsed.data
    });

    res.json(assignment);
  } catch (error) {
    console.error('Error updating class-subject-teacher:', error);
    res.status(500).json({ error: 'Failed to update assignment' });
  }
});

app.delete('/class-subject-teachers/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.classSubjectTeacher.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting class-subject-teacher:', error);
    res.status(500).json({ error: 'Failed to delete assignment' });
  }
});

// Authentication endpoint
app.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({ error: 'Email, password, and role are required' });
    }

    let user = null;

    // Check different user types based on role
    const isFinanceRole = role && (role.toLowerCase() === 'admin' || role.toLowerCase() === 'accountant');
    if (isFinanceRole) {
      // Look for admin/accountant user in the users table
      user = await prisma.user.findFirst({
        where: {
          OR: [
            { email: email },
            { email: { contains: email } }
          ]
        }
      });

      // Verify password against stored hash. An accountant login requires an
      // Accountant user row; an admin login accepts an Admin row.
      if (user && user.email === email && await bcrypt.compare(password, user.password)) {
        if (role.toLowerCase() === 'accountant' && user.role !== 'Accountant') {
          user = null;
        }
      } else {
        user = null;
      }
    } else if (role && role.toLowerCase() === 'teacher') {
      // Look for teacher in the teachers table
      const teacher = await prisma.teacher.findFirst({
        where: {
          OR: [
            { email: email },
            { employeeId: email },
            { phone: email }, // Also check phone in case they enter phone number
            { login: { username: email } } // username assigned on the Teacher Logins screen
          ]
        },
        include: { login: true }
      });

      if (teacher) {
        const session = {
          id: teacher.id,
          email: teacher.email,
          role: 'Teacher',
          name: teacher.name,
          subject: teacher.subject
        };

        if (teacher.login) {
          // A TeacherLogin row is the source of truth: only its password works
          // and a Disabled account cannot sign in. This check used to be missing
          // entirely, so every password set on the Teacher Logins screen was
          // rejected with "Invalid credentials".
          if (teacher.login.status === 'Active' && teacher.login.password === password) {
            user = session;
            prisma.teacherLogin.update({
              where: { id: teacher.login.id },
              data: { lastLogin: new Date() }
            }).catch(() => {});
          }
        }
      }
    } else if (role && role.toLowerCase() === 'student') {
      // First, try to find a StudentLogin with the provided credentials
      const studentLogin = await prisma.studentLogin.findFirst({
        where: {
          OR: [
            { username: email },
            { student: { email: email } },
            { student: { admissionNo: email } }
          ],
          status: 'Active'
        },
        include: { student: true }
      });

      if (studentLogin) {
        // Validate password from StudentLogin
        // Note: In production, use bcrypt.compare for hashed passwords
        if (studentLogin.password === password) {
          user = {
            id: studentLogin.student.id,
            studentId: studentLogin.student.id,
            email: studentLogin.student.email,
            role: 'Student',
            name: studentLogin.student.name,
            admissionNo: studentLogin.student.admissionNo
          };
        }
      } else {
        // Fallback: Look for student in the students table (simplified auth)
        const student = await prisma.student.findFirst({
          where: {
            OR: [
              { email: email },
              { admissionNo: email }
            ]
          }
        });

        if (student) {
          // Students without an Active StudentLogin row cannot sign in
          // Reject unless a login record exists with matching credentials
        }
      }
    }

    if (user) {
      // Generate JWT token - use same fallback as authMiddleware for consistency
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        return res.status(500).json({ error: 'Server misconfigured: JWT_SECRET is not set' });
      }
      const token = jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        jwtSecret,
        { expiresIn: '7d' }
      );

      // Never echo the password hash back to the client.
      const { password: _password, ...safeUser } = user as { password?: string; [key: string]: any };
      return res.json({
        user: safeUser,
        token: token
      });
    }

    return res.status(401).json({ error: 'Invalid credentials' });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------
// Auth: Forgot Password
// ---------------------------------------------------------------
app.post('/auth/forgot-password', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      email: z.string().email('Invalid email address'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { email } = parsed.data;

    // Find user by email across User (Admin), TeacherLogin, StudentLogin
    let userRecord: { id: string; email: string; role: string } | null = null;

    const adminUser = await prisma.user.findFirst({ where: { email } });
    if (adminUser && adminUser.email) {
      userRecord = { id: adminUser.id, email: adminUser.email, role: 'Admin' };
    }

    if (!userRecord) {
      const teacher = await prisma.teacher.findFirst({ where: { email } });
      if (teacher && teacher.email) {
        userRecord = { id: teacher.id, email: teacher.email, role: 'Teacher' };
      }
    }

    if (!userRecord) {
      const student = await prisma.student.findFirst({ where: { email } });
      if (student && student.email) {
        userRecord = { id: student.id, email: student.email, role: 'Student' };
      }
    }

    if (!userRecord) {
      // Don't reveal whether email exists - always return success
      return res.json({ message: 'If an account exists with this email, a reset link has been sent.' });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await prisma.passwordResetToken.create({
      data: {
        token: resetToken,
        userId: userRecord.id,
        expiresAt,
      },
    });

    // Build reset URL - frontend handles the actual reset page
    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:9002'}/auth/reset-password?token=${resetToken}`;

    await sendPasswordResetEmail(email, resetUrl);

    return res.json({ message: 'If an account exists with this email, a reset link has been sent.' });
  } catch (error: any) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ error: 'Failed to process reset request' });
  }
});

// ---------------------------------------------------------------
// Auth: Reset Password
// ---------------------------------------------------------------
app.post('/auth/reset-password', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      token: z.string().min(1, 'Reset token is required'),
      newPassword: z.string().min(6, 'New password must be at least 6 characters'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { token, newPassword } = parsed.data;

    // Find valid reset token
    const resetToken = await prisma.passwordResetToken.findFirst({
      where: {
        token,
        used: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!resetToken) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);

    // Determine user type and update password
    let updatedUser: any;
    if (resetToken.userId.startsWith('cmu')) {
      // Try User (Admin) first
      const adminUser = await prisma.user.findUnique({ where: { id: resetToken.userId } });
      if (adminUser) {
        updatedUser = await prisma.user.update({
          where: { id: resetToken.userId },
          data: { password: newHash },
        });
      } else {
        const teacher = await prisma.teacher.findUnique({ where: { id: resetToken.userId } });
        if (teacher) {
          const teacherLogin = await prisma.teacherLogin.findUnique({ where: { teacherId: teacher.id } });
          if (teacherLogin) {
            updatedUser = await prisma.teacherLogin.update({
              where: { id: teacherLogin.id },
              data: { password: newHash },
            });
          }
        }
      }
    }

    if (!updatedUser) {
      const student = await prisma.student.findUnique({ where: { id: resetToken.userId } });
      if (student) {
        const studentLogin = await prisma.studentLogin.findUnique({ where: { studentId: student.id } });
        if (studentLogin) {
          updatedUser = await prisma.studentLogin.update({
            where: { id: studentLogin.id },
            data: { password: newHash },
          });
        }
      }
    }

    if (!updatedUser) {
      return res.status(404).json({ error: 'User account not found' });
    }

    // Mark token as used
    await prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { used: true },
    });

    // Invalidate all other reset tokens for this user
    await prisma.passwordResetToken.updateMany({
      where: { userId: resetToken.userId, used: false },
      data: { used: true },
    });

    return res.json({ message: 'Password reset successful. You can now log in with your new password.' });
  } catch (error: any) {
    console.error('Reset password error:', error);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ---------------------------------------------------------------
// Auth: Change Password
// ---------------------------------------------------------------
app.post('/auth/change-password', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const userRole = (req as any).user?.role;

    const schema = z.object({
      currentPassword: z.string().min(1, 'Current password is required'),
      newPassword: z.string().min(6, 'New password must be at least 6 characters'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { currentPassword, newPassword } = parsed.data;
    const newHash = await bcrypt.hash(newPassword, 10);

    if (userRole === 'Admin') {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || !user.password) {
        return res.status(404).json({ error: 'User account not found or has no password set' });
      }
      const currentValid = await bcrypt.compare(currentPassword, user.password);
      if (!currentValid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      await prisma.user.update({ where: { id: userId }, data: { password: newHash } });
    } else if (userRole === 'Teacher') {
      const login = await prisma.teacherLogin.findUnique({ where: { teacherId: userId } });
      if (!login || !login.password) {
        return res.status(404).json({ error: 'Teacher login not found or has no password set' });
      }
      const currentValid = await bcrypt.compare(currentPassword, login.password);
      if (!currentValid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      await prisma.teacherLogin.update({ where: { id: login.id }, data: { password: newHash } });
    } else if (userRole === 'Student') {
      const login = await prisma.studentLogin.findUnique({ where: { studentId: userId } });
      if (!login || !login.password) {
        return res.status(404).json({ error: 'Student login not found or has no password set' });
      }
      const currentValid = await bcrypt.compare(currentPassword, login.password);
      if (!currentValid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      await prisma.studentLogin.update({ where: { id: login.id }, data: { password: newHash } });
    } else {
      return res.status(400).json({ error: 'Unknown user role' });
    }

    return res.json({ success: true, message: 'Password changed successfully. Please log in again.' });
  } catch (error: any) {
    console.error('Change password error:', error);
    return res.status(500).json({ error: 'Failed to change password', details: error.message });
  }
});

// ---------------------------------------------------------------
// Auth: Two-Factor Authentication
// ---------------------------------------------------------------

// Generate a TOTP secret and return QR code + manual entry code
app.post('/auth/2fa/setup', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const userEmail = (req as any).user?.email;
    const userRole = (req as any).user?.role;

    if (!userEmail) {
      return res.status(400).json({ error: 'User email not found' });
    }

    const secret = speakeasy.generateSecret({
      length: 32,
      name: `SMS (${userEmail})`,
    });

    // Store the secret unconfirmed; it will be saved only after verification
    await prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: secret.base32 },
    });

    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url!);

    return res.json({
      secret: secret.base32,
      qrCode: qrCodeUrl,
      otpauthUrl: secret.otpauth_url,
    });
  } catch (error: any) {
    console.error('2FA setup error:', error);
    return res.status(500).json({ error: 'Failed to setup 2FA', details: error.message });
  }
});

// Verify the TOTP code and permanently enable 2FA
app.post('/auth/2fa/verify', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    const schema = z.object({
      code: z.string().min(6, 'Code must be 6 digits').max(6, 'Code must be 6 digits'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { code } = parsed.data;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.twoFactorSecret) {
      return res.status(400).json({ error: 'No 2FA setup found. Run setup first.' });
    }

    const verified = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: code,
    });

    if (!verified) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // Generate backup codes
    const backupCodes = Array.from({ length: 8 }, () =>
      Math.floor(Math.random() * 1000000).toString().padStart(6, '0')
    );

    await prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorBackupCodes: JSON.stringify(backupCodes),
      },
    });

    return res.json({
      success: true,
      message: 'Two-factor authentication enabled',
      backupCodes,
    });
  } catch (error: any) {
    console.error('2FA verify error:', error);
    return res.status(500).json({ error: 'Failed to verify 2FA', details: error.message });
  }
});

// Disable 2FA
app.post('/auth/2fa/disable', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    const schema = z.object({
      code: z.string().min(6, 'Code must be 6 digits').max(6, 'Code must be 6 digits'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { code } = parsed.data;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.twoFactorEnabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }

    // Accept TOTP code or a backup code
    let valid = false;

    if (user.twoFactorSecret) {
      valid = speakeasy.totp.verify({
        secret: user.twoFactorSecret,
        encoding: 'base32',
        token: code,
      });
    }

    if (!valid && user.twoFactorBackupCodes) {
      const codes: string[] = JSON.parse(user.twoFactorBackupCodes);
      if (codes.includes(code)) {
        valid = true;
        // Remove the used backup code
        const remaining = codes.filter(c => c !== code);
        await prisma.user.update({
          where: { id: userId },
          data: { twoFactorBackupCodes: JSON.stringify(remaining) },
        });
      }
    }

    if (!valid) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorBackupCodes: null,
      },
    });

    return res.json({ success: true, message: 'Two-factor authentication disabled' });
  } catch (error: any) {
    console.error('2FA disable error:', error);
    return res.status(500).json({ error: 'Failed to disable 2FA', details: error.message });
  }
});

// Get 2FA status
app.get('/auth/2fa/status', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true, twoFactorSecret: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      twoFactorEnabled: user.twoFactorEnabled,
      hasSecret: !!user.twoFactorSecret,
    });
  } catch (error: any) {
    console.error('2FA status error:', error);
    return res.status(500).json({ error: 'Failed to get 2FA status', details: error.message });
  }
});

// ---------------------------------------------------------------
// Teacher Portal Endpoints
app.get('/teacher/dashboard', authMiddleware, checkRole(['Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    // Get teacher information
    const teacher = await prisma.teacher.findFirst({
      where: { email: user.email },
      include: { classes: true }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Head-teacher (assigned) classes only
    const classes = await Promise.all(
      (teacher.classes || []).map(async (cls: any) => ({
        id: cls.id,
        name: cls.name,
        section: cls.section,
        studentCount: await prisma.student.count({ where: { class: cls.name, section: cls.section } }),
        isClassTeacher: true
      }))
    );

    // No class routine endpoint exists yet, so today's schedule stays empty
    // (do not fabricate time slots / rooms).
    const todaysClasses: any[] = [];

    const now = new Date();
    const relevantExams = await teacherRelevantExams(teacher);
    const sortByStart = (a: any, b: any) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
    const ongoingExams = relevantExams
      .filter((e: any) => new Date(e.startDate) <= now && new Date(e.endDate) >= now)
      .sort(sortByStart)
      .slice(0, 5);
    const upcomingExams = relevantExams
      .filter((e: any) => new Date(e.startDate) >= now)
      .sort(sortByStart)
      .slice(0, 5);

    const stats = {
      teacher: {
        id: teacher.id,
        name: teacher.name,
        email: teacher.email,
        subject: teacher.subject,
        classes
      },
      todaysClasses,
      pendingAttendance: todaysClasses.length,
      assignmentsToReview: 0,
      ongoingExams,
      upcomingExams,
      messages: [],
      recentNotices: []
    };

    res.json(stats);
  } catch (error) {
    console.error('Error fetching teacher dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

async function teacherPermissionRecord(teacher: any) {
  if (teacher.permission) return teacher.permission;
  try {
    return await prisma.teacherPermission.upsert({
      where: { teacherId: teacher.id },
      update: {},
      create: { teacherId: teacher.id }
    });
  } catch (error: any) {
    const existing = await prisma.teacherPermission.findUnique({ where: { teacherId: teacher.id } });
    if (existing) return existing;
    throw error;
  }
}

async function teacherAllowedClassIds(teacher: any, scope: 'attendance' | 'marks'): Promise<Set<string>> {
  const permission = await teacherPermissionRecord(teacher);
  const mode = scope === 'attendance' ? permission.attendanceMode : permission.marksMode;
  const ids = scope === 'attendance' ? permission.attendanceClassIds : permission.marksClassIds;

  if (mode === 'all') {
    const all = await prisma.schoolClass.findMany({ select: { id: true } });
    return new Set(all.map((c: any) => c.id));
  }
  if (mode === 'specific') return new Set(ids || []);
  if (mode === 'none') return new Set();
  return new Set((teacher.classes || []).map((c: any) => c.id));
}

async function teacherAllowedClassIdsAll(teacher: any): Promise<Set<string>> {
  const [a, b] = await Promise.all([
    teacherAllowedClassIds(teacher, 'attendance'),
    teacherAllowedClassIds(teacher, 'marks')
  ]);
  return new Set([...Array.from(a), ...Array.from(b)]);
}

async function teacherScopeClasses(teacher: any, scope: 'attendance' | 'marks') {
  const allowed = await teacherAllowedClassIds(teacher, scope);
  if (allowed.size === 0) return [];
  const classTeacherIds = new Set((teacher.classes || []).map((c: any) => c.id));
  const classes = await prisma.schoolClass.findMany({
    where: { id: { in: Array.from(allowed) } },
    orderBy: [{ name: 'asc' }, { section: 'asc' }]
  });
  return Promise.all(
    classes.map(async (cls: any) => ({
      id: cls.id,
      name: cls.name,
      section: cls.section,
      studentCount: await prisma.student.count({ where: { class: cls.name, section: cls.section } }),
      isClassTeacher: classTeacherIds.has(cls.id)
    }))
  );
}

async function teacherEffectiveClasses(teacher: any, scope: string) {
  if (scope === 'all') {
    const [a, b] = await Promise.all([
      teacherScopeClasses(teacher, 'attendance'),
      teacherScopeClasses(teacher, 'marks')
    ]);
    const map = new Map<string, any>();
    [...a, ...b].forEach((c: any) => map.set(c.id, c));
    return Array.from(map.values());
  }
  return teacherScopeClasses(teacher, scope as 'attendance' | 'marks');
}

// Which exams are relevant to this teacher.
// Permission-aware:
//   marksMode 'all'      -> unrestricted (all exams; admin granted everything)
//   marksMode 'specific' -> exams covering marksClassIds classes (any subject)
//   marksMode 'assigned'/'none' -> exams matching the teacher's recorded (class, subject)
//       pairs from ClassSubjectTeacher; falls back to assigned classes + teacher.subject
//       match when no pairs are recorded.
async function teacherExamScope(teacher: any) {
  const permission = await teacherPermissionRecord(teacher);
  const mode = permission.marksMode;
  if (mode === 'all') return { unrestricted: true, pairs: null as any, classIds: null as any, subjectIds: null as any };
  if (mode === 'specific') {
    return { unrestricted: false, pairs: null as any, classIds: new Set<string>(permission.marksClassIds || []), subjectIds: null as any };
  }

  const pairs = await prisma.classSubjectTeacher.findMany({
    where: { teacherId: teacher.id },
    select: { classId: true, subjectId: true }
  });
  if (pairs.length > 0) {
    return {
      unrestricted: false,
      pairs: pairs.map((p: any) => ({ classId: p.classId, subjectId: p.subjectId })),
      classIds: null as any,
      subjectIds: null as any
    };
  }

  const classIds = new Set<string>((teacher.classes || []).map((c: any) => c.id));
  const subjName = (teacher.subject || '').trim().toLowerCase();
  const subjectIds = new Set<string>();
  if (subjName) {
    const subjects = await prisma.subject.findMany({ select: { id: true, name: true } });
    subjects.forEach((s: any) => {
      if ((s.name || '').trim().toLowerCase() === subjName) subjectIds.add(s.id);
    });
  }
  return { unrestricted: false, pairs: null as any, classIds, subjectIds: subjectIds.size > 0 ? subjectIds : null as any };
}

async function teacherRelevantExams(teacher: any): Promise<Array<any>> {
  const scope = await teacherExamScope(teacher);

  let examIds: Set<string> | null = null;
  if (!scope.unrestricted) {
    const OR: any[] = [];
    if (scope.pairs) {
      for (const p of scope.pairs) OR.push({ classId: p.classId, subjectId: p.subjectId });
    } else {
      if (scope.classIds && scope.classIds.size > 0) OR.push({ classId: { in: Array.from(scope.classIds) } });
      if (scope.subjectIds && scope.subjectIds.size > 0) OR.push({ subjectId: { in: Array.from(scope.subjectIds) } });
    }
    if (OR.length > 0) {
      const schedules = await prisma.examSchedule.findMany({ where: { OR }, select: { examId: true } });
      examIds = new Set(schedules.map((s: any) => s.examId));
    } else {
      examIds = new Set();
    }
  }

  const exams = await prisma.exam.findMany({
    where: examIds ? { id: { in: Array.from(examIds) } } : {},
    include: { type: true, schedules: { include: { class: true } } },
    orderBy: { startDate: 'asc' }
  });

  // Only advertise the classes this teacher may actually open â€” an exam card
  // listing every scheduled class sent them to entries that 403'd.
  const allowedClassIds = await teacherAllowedClassIdsAll(teacher);

  return exams.map((e: any) => {
    const classMap = new Map<string, any>();
    (e.schedules || []).forEach((s: any) => {
      if (s.class && allowedClassIds.has(s.class.id)) classMap.set(s.class.id, { id: s.class.id, name: s.class.name, section: s.class.section });
    });
    return {
      id: e.id,
      name: e.name,
      type: e.type?.name || '',
      date: toDateStr(e.startDate),
      startDate: e.startDate,
      endDate: e.endDate,
      classes: Array.from(classMap.values())
    };
  });
}

app.get('/teacher/classes', authMiddleware, checkRole(['Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    // Get teacher information
    const teacher = await prisma.teacher.findFirst({
      where: { email: user.email },
      include: { classes: true, permission: true }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const scope = req.query.scope === 'attendance' || req.query.scope === 'marks' ? String(req.query.scope) : 'all';
    let classes = await teacherEffectiveClasses(teacher, scope);

    const examId = typeof req.query.examId === 'string' && req.query.examId ? String(req.query.examId) : '';
    if (examId) {
      const schedules = await prisma.examSchedule.findMany({
        where: { examId },
        select: { classId: true }
      });
      const scheduledClassIds = new Set<string>(
        schedules.map((s: any) => s.classId).filter((id: any): id is string => !!id)
      );
      // Only restrict to classes that had the exam when schedules exist,
      // so entry is not blocked if routines weren't created for this exam.
      if (scheduledClassIds.size > 0) {
        classes = classes.filter((cls: any) => scheduledClassIds.has(cls.id));
      }
    }

    res.json(classes);
  } catch (error) {
    console.error('Error fetching teacher classes:', error);
    res.status(500).json({ error: 'Failed to fetch classes' });
  }
});

app.get('/teacher/classes/:id/students', authMiddleware, checkRole(['Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { id: classId } = req.params;

    // Get teacher information
    const teacher = await prisma.teacher.findFirst({
      where: { email: user.email },
      include: { classes: true, permission: true }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const scope = req.query.scope === 'attendance' || req.query.scope === 'marks' ? String(req.query.scope) : 'all';
    const allowed = scope === 'all' ? await teacherAllowedClassIdsAll(teacher) : await teacherAllowedClassIds(teacher, scope as 'attendance' | 'marks');

    if (!allowed.has(classId)) {
      return res.status(403).json({ error: 'You are not assigned to this class' });
    }

    const classInfo = await prisma.schoolClass.findUnique({ where: { id: classId } });
    if (!classInfo) {
      return res.status(404).json({ error: 'Class not found' });
    }

    // Get students for this class using Student model
    const students = await prisma.student.findMany({
      where: {
        class: classInfo.name,
        section: classInfo.section
      },
      select: {
        id: true,
        name: true,
        roll: true,
        admissionNo: true,
        gender: true,
        status: true
      },
      orderBy: { roll: 'asc' }
    });

    res.json(students);
  } catch (error) {
    console.error('Error fetching class students:', error);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

app.get('/teacher/subjects', authMiddleware, checkRole(['Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    // Get teacher information
    const teacher = await prisma.teacher.findFirst({
      where: { email: user.email }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Get real subjects from the Subject table
    const subjects = await prisma.subject.findMany({
      select: { id: true, name: true, code: true, type: true },
      orderBy: { name: 'asc' }
    });

    res.json(subjects);
  } catch (error) {
    console.error('Error fetching teacher subjects:', error);
    res.status(500).json({ error: 'Failed to fetch subjects' });
  }
});

app.get('/teacher/attendance', authMiddleware, checkRole(['Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { classId, date } = req.query;

    if (!classId || !date) {
      return res.status(400).json({ error: 'Class ID and date are required' });
    }

    // Get teacher information
    const teacher = await prisma.teacher.findFirst({
      where: { email: user.email },
      include: { classes: true, permission: true }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const allowed = await teacherAllowedClassIds(teacher, 'attendance');
    if (allowed.size === 0) {
      return res.status(403).json({ error: 'Your attendance permission is not configured' });
    }
    if (!allowed.has(String(classId))) {
      return res.status(403).json({ error: 'You are not assigned to this class' });
    }

    const classInfo = await prisma.schoolClass.findUnique({ where: { id: String(classId) } });
    if (!classInfo) {
      return res.status(404).json({ error: 'Class not found' });
    }

    // Get students for this class using Student model (on-roll only, so
    // inactive/graduated students are never marked by teachers either)
    const students = await prisma.student.findMany({
      where: {
        class: classInfo.name,
        section: classInfo.section,
        status: ACTIVE_STUDENT_STATUS
      },
      select: {
        id: true,
        name: true,
        roll: true
      },
      orderBy: { roll: 'asc' }
    });

    // Load any existing attendance for this class on the requested date.
    // Standardize the day to the UTC-midnight form used at save time.
    const dayStart = utcMidnight(attendanceDayKey(String(date)));
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const savedRecords = await prisma.attendance.findMany({
      where: {
        date: { gte: dayStart, lt: dayEnd },
        studentId: { in: students.map((s) => s.id) }
      },
      select: { studentId: true, status: true, leave: { select: { category: true, leaveType: true, halfDaySession: true } } }
    });
    const statusMap = new Map(savedRecords.map((r) => [r.studentId, r.status]));
    const leaveInfoMap = new Map(savedRecords.filter((r) => r.leave).map((r) => [r.studentId, r.leave]));

    const studentData = students.map(student => {
      const status = statusMap.has(student.id) ? lowerAttendanceStatus(statusMap.get(student.id)) : 'present';
      const leaveInfo = leaveInfoMap.get(student.id) as any;
      return {
        studentId: student.id,
        studentName: student.name,
        roll: student.roll,
        status,
        // Approved-left students surface an explicit indicator so teachers do
        // not mark them absent by mistake; the save endpoint also enforces it.
        onLeave: status === 'leave',
        leaveCategory: leaveInfo?.category || null,
        leaveType: leaveInfo?.leaveType || null,
        halfDaySession: leaveInfo?.halfDaySession || null,
      };
    });

    res.json(studentData);
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance data' });
  }
});

app.post('/teacher/attendance', authMiddleware, checkRole(['Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { classId, date, records, override } = req.body;

    if (!classId || !date || !records) {
      return res.status(400).json({ error: 'Class ID, date, and records are required' });
    }

    // Get teacher information
    const teacher = await prisma.teacher.findFirst({
      where: { email: user.email },
      include: { classes: true, permission: true }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const allowed = await teacherAllowedClassIds(teacher, 'attendance');
    if (allowed.size === 0) {
      return res.status(403).json({ error: 'Your attendance permission is not configured' });
    }
    if (!allowed.has(String(classId))) {
      return res.status(403).json({ error: 'You are not assigned to this class' });
    }

    const classInfo = await prisma.schoolClass.findUnique({ where: { id: String(classId) } });
    if (!classInfo) {
      return res.status(404).json({ error: 'Class not found' });
    }

    // Save attendance to the Attendance table (same as /attendance/save)
    const day = utcMidnight(attendanceDayKey(String(date)));
    const students = await prisma.student.findMany({
      where: { class: classInfo.name, section: classInfo.section, status: ACTIVE_STUDENT_STATUS }
    });
    const ids = new Set(students.map((s) => s.id));
    const toSave = (records as any[]).filter((r: any) => r.studentId && ids.has(r.studentId));

    if (toSave.length === 0) {
      return res.status(400).json({ error: 'No valid student records provided' });
    }

    // Approved full-day leaves protect their synchronized rows from accidental
    // overrides (e.g. an absent mark for an on-leave student).
    try {
      await assertAttendanceLeaveGuard(
        toSave.map((r: any) => ({ studentId: r.studentId, status: normalizeAttendanceStatus(r.status) })),
        day,
        Boolean(override)
      );
    } catch (guardError: any) {
      return res.status(guardError.status || guardError.statusCode || 500).json({ error: guardError.message });
    }

    await prisma.$transaction(
      toSave.map((r: any) => {
        const status = normalizeAttendanceStatus(r.status);
        return prisma.attendance.upsert({
          where: { studentId_date: { studentId: r.studentId, date: day } },
          update: { status },
          create: { studentId: r.studentId, date: day, status }
        });
      })
    );

    res.json({ success: true, message: 'Attendance saved successfully', count: toSave.length });
  } catch (error) {
    console.error('Error saving attendance:', error);
    res.status(500).json({ error: 'Failed to save attendance' });
  }
});

app.get('/teacher/exams', authMiddleware, checkRole(['Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    // Get teacher information
    // `classes` is required: teacherExamScope falls back to the teacher's
    // assigned classes in 'assigned' mode, so omitting it silently resolved
    // every such teacher to zero classes and therefore zero exams.
    const teacher = await prisma.teacher.findFirst({
      where: { email: user.email },
      include: { classes: true, permission: true }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Exams relevant to this teacher (permission-aware: all / specific classes / own classes+subject pairs)
    const exams = await teacherRelevantExams(teacher);

    res.json(exams.map((e: any) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      date: e.date,
      startDate: e.startDate,
      endDate: e.endDate,
      classes: e.classes
    })));
  } catch (error) {
    console.error('Error fetching teacher exams:', error);
    res.status(500).json({ error: 'Failed to fetch exams' });
  }
});

// Class Routine Management
const ROUTINE_COLORS = [
  'bg-blue-100 border-blue-200 text-blue-800',
  'bg-green-100 border-green-200 text-green-800',
  'bg-pink-100 border-pink-200 text-pink-800',
  'bg-orange-100 border-orange-200 text-orange-800',
  'bg-purple-100 border-purple-200 text-purple-800',
  'bg-yellow-100 border-yellow-200 text-yellow-800',
  'bg-indigo-100 border-indigo-200 text-indigo-800',
  'bg-red-100 border-red-200 text-red-800',
];

function routineColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return ROUTINE_COLORS[hash % ROUTINE_COLORS.length];
}

app.get('/class-routine/classes', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (_req: Request, res: Response) => {
  try {
    const classes = await prisma.schoolClass.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        section: true
      }
    });

    // Group classes by name and collect sections
    const groupedClasses = classes.reduce((acc, cls) => {
      const existingClass = acc.find(c => c.name === cls.name);
      if (existingClass) {
        existingClass.sections.push({ id: cls.section, name: cls.section });
      } else {
        acc.push({
          id: cls.id,
          name: cls.name,
          sections: [{ id: cls.section, name: cls.section }]
        });
      }
      return acc;
    }, [] as any[]);

    res.json(groupedClasses);
  } catch (error) {
    console.error('Error fetching classes:', error);
    res.status(500).json({ error: 'Failed to fetch classes' });
  }
});

app.get('/class-routine/teachers', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (_req: Request, res: Response) => {
  try {
    const teachers = await prisma.teacher.findMany({
      where: { status: 'Active' },
      select: {
        id: true,
        name: true,
        email: true,
        subject: true
      },
      orderBy: { name: 'asc' }
    });

    res.json(teachers);
  } catch (error) {
    console.error('Error fetching teachers:', error);
    res.status(500).json({ error: 'Failed to fetch teachers' });
  }
});

app.get('/class-routine/subjects', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (_req: Request, res: Response) => {
  try {
    const subjects = await prisma.subject.findMany({
      select: {
        id: true,
        name: true,
        code: true,
        type: true
      },
      orderBy: { name: 'asc' }
    });

    res.json(subjects);
  } catch (error) {
    console.error('Error fetching subjects:', error);
    res.status(500).json({ error: 'Failed to fetch subjects' });
  }
});

app.get('/class-routine/rooms', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (_req: Request, res: Response) => {
  try {
    // Return mock room data since there's no Room model in the schema
    const rooms = [
      { id: 'R-101', name: 'R-101', capacity: 30 },
      { id: 'R-102', name: 'R-102', capacity: 30 },
      { id: 'R-103', name: 'R-103', capacity: 30 },
      { id: 'R-201', name: 'R-201', capacity: 25 },
      { id: 'R-202', name: 'R-202', capacity: 25 },
      { id: 'R-203', name: 'R-203', capacity: 25 },
      { id: 'R-301', name: 'R-301', capacity: 35 },
      { id: 'R-302', name: 'R-302', capacity: 35 },
      { id: 'R-303', name: 'R-303', capacity: 35 },
      { id: 'Lab-1', name: 'Computer Lab 1', capacity: 20 },
      { id: 'Lab-2', name: 'Science Lab 2', capacity: 20 }
    ];

    res.json(rooms);
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

app.get('/class-routine/time-slots', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (_req: Request, res: Response) => {
  try {
    const defaultSlots = [
      { id: '1', period: 'Period 1', timeRange: '08:00 - 08:40', isBreak: false },
      { id: '2', period: 'Period 2', timeRange: '08:40 - 09:20', isBreak: false },
      { id: '3', period: 'Period 3', timeRange: '09:20 - 10:00', isBreak: false },
      { id: 'break', period: 'Break', timeRange: '10:00 - 10:20', isBreak: true },
      { id: '4', period: 'Period 4', timeRange: '10:20 - 11:00', isBreak: false },
      { id: '5', period: 'Period 5', timeRange: '11:00 - 11:40', isBreak: false },
      { id: '6', period: 'Period 6', timeRange: '11:40 - 12:20', isBreak: false },
      { id: '7', period: 'Period 7', timeRange: '12:20 - 01:00', isBreak: false },
    ];

    const persisted = await prisma.routinePeriod.findMany({
      orderBy: { sortOrder: 'asc' }
    });

    if (persisted.length === 0) {
      const seeded = await prisma.$transaction(
        defaultSlots.map((slot, index) =>
          prisma.routinePeriod.create({
            data: {
              period: slot.period,
              timeRange: slot.timeRange,
              isBreak: slot.isBreak,
              sortOrder: index
            }
          })
        )
      );

      return res.json(seeded.map(p => ({
        id: p.id,
        period: p.period,
        timeRange: p.timeRange,
        isBreak: p.isBreak
      })));
    }

    res.json(persisted.map(p => ({
      id: p.id,
      period: p.period,
      timeRange: p.timeRange,
      isBreak: p.isBreak
    })));
  } catch (error) {
    console.error('Error fetching time slots:', error);
    res.status(500).json({ error: 'Failed to fetch time slots' });
  }
});

app.post('/class-routine/periods/save', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      id: z.string().optional(),
      period: z.string().min(1),
      timeRange: z.string().min(1),
      isBreak: z.boolean().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { id, period, timeRange, isBreak } = parsed.data;

    if (id) {
      await prisma.routinePeriod.update({
        where: { id },
        data: { period, timeRange, isBreak: isBreak ?? false }
      });
    } else {
      const maxOrder = await prisma.routinePeriod.aggregate({ _max: { sortOrder: true } });
      await prisma.routinePeriod.create({
        data: { period, timeRange, isBreak: isBreak ?? false, sortOrder: (maxOrder._max.sortOrder ?? -1) + 1 }
      });
    }

    const all = await prisma.routinePeriod.findMany({ orderBy: { sortOrder: 'asc' } });
    res.json(all.map(p => ({ id: p.id, period: p.period, timeRange: p.timeRange, isBreak: p.isBreak })));
  } catch (error) {
    console.error('Error saving period:', error);
    res.status(500).json({ error: 'Failed to save period' });
  }
});

app.post('/class-routine/periods/reorder', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({ ids: z.array(z.string()).min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { ids } = parsed.data;
    await prisma.$transaction(
      ids.map((id, index) => prisma.routinePeriod.update({
        where: { id },
        data: { sortOrder: index }
      }))
    );

    // Renumber non-break periods so their names follow the new position.
    const ordered = await prisma.routinePeriod.findMany({ orderBy: { sortOrder: 'asc' } });
    let periodNumber = 0;
    const renameOps: any[] = [];
    for (const p of ordered) {
      if (p.isBreak) continue;
      periodNumber += 1;
      const name = `Period ${periodNumber}`;
      if (p.period !== name) {
        renameOps.push(prisma.routinePeriod.update({ where: { id: p.id }, data: { period: name } }));
      }
    }
    if (renameOps.length > 0) {
      await prisma.$transaction(renameOps);
    }

    const all = await prisma.routinePeriod.findMany({ orderBy: { sortOrder: 'asc' } });
    res.json(all.map(p => ({ id: p.id, period: p.period, timeRange: p.timeRange, isBreak: p.isBreak })));
  } catch (error) {
    console.error('Error reordering periods:', error);
    res.status(500).json({ error: 'Failed to reorder periods' });
  }
});

app.delete('/class-routine/periods/:id', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  try {
    await prisma.routinePeriod.delete({ where: { id: req.params.id } });
    const all = await prisma.routinePeriod.findMany({ orderBy: { sortOrder: 'asc' } });
    res.json(all.map(p => ({ id: p.id, period: p.period, timeRange: p.timeRange, isBreak: p.isBreak })));
  } catch (error) {
    console.error('Error deleting period:', error);
    res.status(500).json({ error: 'Failed to delete period' });
  }
});

app.get('/class-routine/timetable', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  try {
    const { classId, section } = req.query;

    if (!classId || !section) {
      return res.status(400).json({ error: 'Class ID and section are required' });
    }

    // Get class information
    const classInfo = await prisma.schoolClass.findUnique({
      where: { id: classId as string }
    });

    if (!classInfo || classInfo.section !== section) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const entries = await prisma.routineEntry.findMany({
      where: { classId: classId as string, section: section as string }
    });

    const timetable: Record<string, any> = {};
    for (const e of entries) {
      const key = `${e.day}-${e.period}`;
      timetable[key] = {
        id: e.id,
        name: e.subject,
        teacher: e.teacher || '',
        room: e.room || '',
        color: routineColorFor(e.subject)
      };
    }

    res.json({ [`${classId}-${section}`]: timetable });
  } catch (error) {
    console.error('Error fetching timetable:', error);
    res.status(500).json({ error: 'Failed to fetch timetable' });
  }
});

app.post('/class-routine/update-entry', authMiddleware, authMiddleware, checkRole(['Admin', 'Teacher']), async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      classId: z.string(),
      section: z.string(),
      day: z.enum(['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']),
      period: z.string(),
      subject: z.string(),
      teacher: z.string().optional(),
      room: z.string().optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { classId, section, day, period, subject, teacher, room } = parsed.data;

    // Empty subject clears the cell
    if (!subject || !subject.trim()) {
      await prisma.routineEntry.deleteMany({
        where: { classId, section, day, period }
      });
      return res.json({ success: true, message: 'Entry removed' });
    }

    await prisma.routineEntry.upsert({
      where: {
        classId_section_day_period: { classId, section, day, period }
      },
      update: { subject, teacher: teacher || null, room: room || null },
      create: { classId, section, day, period, subject, teacher: teacher || null, room: room || null }
    });

    res.json({ success: true, message: 'Entry updated successfully' });
  } catch (error) {
    console.error('Error updating routine entry:', error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// Teacher Marks Entry
//
// Subject scope for a marks write. Class access on its own used to be enough to
// save marks for any subject in that class â€” including another teacher's. When
// recorded (class, subject) assignments exist only those pairs are writable,
// otherwise the teacher's own subject is the limit. Marks mode 'all'/'specific'
// is a deliberate admin grant of every subject, so it stays unrestricted.
// Returns null when allowed, otherwise the error message.
async function teacherMarksSubjectError(
  teacher: any,
  classId: string,
  subjectIds: Array<string | undefined>
): Promise<string | null> {
  const permission = await teacherPermissionRecord(teacher);
  if (permission.marksMode === 'all' || permission.marksMode === 'specific') return null;

  const pairs = await prisma.classSubjectTeacher.findMany({
    where: { teacherId: teacher.id },
    select: { classId: true, subjectId: true }
  });
  let allowedSubjectIds: Set<string> | null = null;
  if (pairs.length > 0) {
    allowedSubjectIds = new Set(pairs.filter((p: any) => p.classId === classId).map((p: any) => p.subjectId));
  } else {
    const teacherSubjectName = String(teacher.subject || '').trim();
    if (teacherSubjectName) {
      const subject = await prisma.subject.findFirst({
        where: { name: teacherSubjectName },
        select: { id: true }
      });
      if (subject) allowedSubjectIds = new Set([subject.id]);
    }
  }
  if (!allowedSubjectIds || allowedSubjectIds.size === 0) return null;
  return subjectIds.some((sid) => !sid || !allowedSubjectIds!.has(sid))
    ? 'You are not assigned to this subject'
    : null;
}

// Existing marks for one (exam, class, subject), so the entry grid loads what is
// already saved. Without this the page opened blank and saving wrote 0 for every
// student, wiping the record. Same class/subject scope as the write.
app.get('/teacher/marks', authMiddleware, checkRole(['Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { examId, classId, subjectId } = req.query;

    if (!examId || !classId || !subjectId) {
      return res.status(400).json({ error: 'Exam ID, Class ID and Subject ID are required' });
    }

    const teacher = await prisma.teacher.findFirst({
      where: { email: user.email },
      include: { classes: true, permission: true }
    });
    if (!teacher) return res.status(404).json({ error: 'Teacher not found' });

    const allowed = await teacherAllowedClassIds(teacher, 'marks');
    if (!allowed.has(String(classId))) {
      return res.status(403).json({ error: 'You are not assigned to this class' });
    }

    const subjectError = await teacherMarksSubjectError(teacher, String(classId), [String(subjectId)]);
    if (subjectError) return res.status(403).json({ error: subjectError });

    const classInfo = await prisma.schoolClass.findUnique({
      where: { id: String(classId) },
      select: { name: true, section: true }
    });
    if (!classInfo) return res.status(404).json({ error: 'Class not found' });

    const students = await prisma.student.findMany({
      where: { class: classInfo.name, section: classInfo.section },
      select: { id: true },
      orderBy: { roll: 'asc' }
    });
    const studentIds = students.map((s: any) => s.id);
    if (studentIds.length === 0) return res.json({ marks: [] });

    const rows = await prisma.result.findMany({
      where: { examId: String(examId), subjectId: String(subjectId), studentId: { in: studentIds } },
      select: { studentId: true, written: true, mcq: true, practical: true, totalMarks: true, grade: true, gp: true }
    });

    res.json({
      marks: rows.map((r: any) => ({
        studentId: r.studentId,
        written: r.written ?? null,
        mcq: r.mcq ?? null,
        practical: r.practical ?? null,
        total: r.totalMarks ?? null,
        grade: r.grade ?? null,
        gp: r.gp ?? null
      })),
    });
  } catch (error) {
    console.error('Error fetching teacher marks:', error);
    res.status(500).json({ error: 'Failed to load marks' });
  }
});

app.post('/teacher/marks', authMiddleware, checkRole(['Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { examId, classId, marks, subjectId: requestedSubjectId } = req.body;

    if (!examId || !classId || !marks || !Array.isArray(marks)) {
      return res.status(400).json({ error: 'Exam ID, Class ID, and marks are required' });
    }

    // Get teacher information
    const teacher = await prisma.teacher.findFirst({
      where: { email: user.email },
      include: { classes: true, permission: true }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const allowed = await teacherAllowedClassIds(teacher, 'marks');
    if (!allowed.has(classId)) {
      return res.status(403).json({ error: 'You are not assigned to this class' });
    }

    // Resolve subject for this marks submission.
    // Prefer explicit subjectId from request, then per-mark subjectId,
    // then teacher's assigned subject mapped by name.
    let fallbackSubjectId: string | undefined = requestedSubjectId;
    if (!fallbackSubjectId) {
      const teacherSubjectName = String((teacher as any).subject || '').trim();
      if (teacherSubjectName) {
        const subject = await prisma.subject.findFirst({
          where: { name: teacherSubjectName },
          select: { id: true }
        });
        fallbackSubjectId = subject?.id;
      }
    }

    const subjectError = await teacherMarksSubjectError(
      teacher,
      String(classId),
      (marks as any[]).map((m: any) => m.subjectId || fallbackSubjectId)
    );
    if (subjectError) {
      return res.status(403).json({ error: subjectError });
    }

    // The students must belong to the class being marked. Passing the check on
    // classId alone let a teacher write marks for any student id, including one
    // in a class they have no access to.
    const classInfo = await prisma.schoolClass.findUnique({
      where: { id: String(classId) },
      select: { name: true, section: true }
    });
    if (!classInfo) {
      return res.status(404).json({ error: 'Class not found' });
    }
    const classStudents = await prisma.student.findMany({
      where: { class: classInfo.name, section: classInfo.section },
      select: { id: true }
    });
    const classStudentIds = new Set(classStudents.map((s: any) => s.id));
    if ((marks as any[]).some((m: any) => !classStudentIds.has(m.studentId))) {
      return res.status(403).json({ error: 'One or more students are not in this class' });
    }

    const exam = await prisma.exam.findUnique({ where: { id: String(examId) }, select: { id: true, typeId: true, status: true } });
    if (!exam) return res.status(404).json({ error: 'Exam not found' });
    if (exam.status === 'Published') {
      return res.status(403).json({ error: 'Cannot edit marks for published results. Unpublish the exam first.' });
    }

    const resolvedSubjectIds = Array.from(new Set((marks as any[])
      .map((m: any) => m.subjectId || fallbackSubjectId)
      .filter((id: any): id is string => !!id)));
    const [schedules, allGrading, attendanceRows] = await Promise.all([
      prisma.examSchedule.findMany({ where: { examId: String(examId), subjectId: { in: resolvedSubjectIds } } }),
      prisma.gradingSystem.findMany({ orderBy: { minPercent: 'desc' } }),
      prisma.examAttendance.findMany({
        where: {
          examId: String(examId),
          subjectId: { in: resolvedSubjectIds },
          studentId: { in: [...classStudentIds] },
        },
        select: { studentId: true, subjectId: true, status: true },
      }),
    ]);
    const gradingByType = new Map<string, typeof allGrading>();
    for (const g of allGrading) {
      const key = g.examTypeId ?? '__template__';
      if (!gradingByType.has(key)) gradingByType.set(key, []);
      gradingByType.get(key)!.push(g);
    }
    const defaultGrading = gradingByType.get(exam.typeId ?? '') || [];
    const absentKeys = new Set(attendanceRows.filter((a) => a.status === 'ABSENT').map((a) => `${a.studentId}|${a.subjectId}`));
    const passFor = (full: number, explicit?: number | null) => {
      const max = Math.max(0, Number(full) || 0);
      const configured = Number(explicit) || 0;
      return configured > 0 && configured <= max ? configured : Math.min(max, Math.round(max * 0.33));
    };

    const normalized = (marks as any[]).map((mark: any) => {
      const resolvedSubjectId = mark.subjectId || fallbackSubjectId;
      if (!resolvedSubjectId) throw new HttpError(400, 'subjectId is required to save marks');

      const schedule = schedules.find((s) => s.subjectId === resolvedSubjectId && s.classId === String(classId))
        || schedules.find((s) => s.subjectId === resolvedSubjectId && !s.classId);
      if (!schedule) throw new HttpError(400, `No schedule found for ${resolvedSubjectId} in this class`);

      const gradingForSchedule = gradingByType.get(schedule.gradingTypeId || exam.typeId || '') || defaultGrading;
      const template = gradingForSchedule[0] as any;
      const writtenFull = (schedule.writtenFullMarks || 0) > 0 ? schedule.writtenFullMarks! : (template?.writtenFull ?? 0);
      const mcqFull = (schedule.mcqFullMarks || 0) > 0 ? schedule.mcqFullMarks! : (template?.mcqFull ?? 0);
      const practicalFull = (schedule.practicalFullMarks || 0) > 0 ? schedule.practicalFullMarks! : (template?.practicalFull ?? 0);
      const totalFull = (schedule.fullMarks || 0) > 0
        ? schedule.fullMarks!
        : ((template?.totalFull ?? 0) || writtenFull + mcqFull + practicalFull || 100);

      const written = Number(mark.written) || 0;
      const mcq = Number(mark.mcq) || 0;
      const practical = Number(mark.practical) || 0;
      if (![written, mcq, practical].every((v) => Number.isFinite(v) && v >= 0)) {
        throw new HttpError(400, `Marks cannot be negative for student ${mark.studentId}`);
      }
      if (written > writtenFull) throw new HttpError(400, `Written marks (${written}) exceed maximum (${writtenFull})`);
      if (mcq > mcqFull) throw new HttpError(400, `MCQ marks (${mcq}) exceed maximum (${mcqFull})`);
      if (practical > practicalFull) throw new HttpError(400, `Practical marks (${practical}) exceed maximum (${practicalFull})`);
      if (absentKeys.has(`${mark.studentId}|${resolvedSubjectId}`)) {
        throw new HttpError(400, `Cannot enter marks for absent student ${mark.studentId}`);
      }

      const totalMarks = written + mcq + practical;
      if (totalMarks > totalFull) {
        throw new HttpError(400, `Total marks (${totalMarks}) exceed full marks (${totalFull})`);
      }

      const writtenPass = passFor(writtenFull, schedule.writtenPassMarks);
      const mcqPass = passFor(mcqFull, schedule.mcqPassMarks);
      const practicalPass = passFor(practicalFull, schedule.practicalPassMarks);
      const totalPass = passFor(totalFull, schedule.passMarks);
      const isFail = (writtenFull > 0 && written < writtenPass)
        || (mcqFull > 0 && mcq < mcqPass)
        || (practicalFull > 0 && practical < practicalPass)
        || totalMarks < totalPass;

      let bands: any[] = gradingForSchedule;
      let snapshotFull = 0;
      if (schedule.gradingSnapshot) {
        const snapshot = parseGradingSnapshot(schedule.gradingSnapshot);
        if (Array.isArray(snapshot?.bands) && snapshot.bands.length > 0) {
          bands = snapshot.bands;
          if (typeof snapshot.totalFull === 'number' && snapshot.totalFull > 0) snapshotFull = snapshot.totalFull;
        }
      }

      let gradeInfo: any;
      if (isFail) {
        gradeInfo = bands.find((b: any) => String(b.status).toUpperCase() === 'FAIL') || { grade: 'F', gp: 0 };
      } else {
        const percent = totalFull > 0 ? (totalMarks / totalFull) * 100 : 0;
        const bandRef = snapshotFull || template?.totalFull || 100;
        const bandMax = Math.max(...bands.map((b: any) => Number(b.maxPercent) || 0));
        const asPctRef = bandMax > 0 && bandRef > 0 ? Math.min(bandMax, bandRef) : (bandMax || bandRef || 100);
        const asPct = (v: any) => ((Number(v) || 0) / asPctRef) * 100;
        const sorted = [...bands].sort((a: any, b: any) => asPct(a.minPercent) - asPct(b.minPercent));
        let matched: any = null;
        for (const band of sorted) {
          if (asPct(band.minPercent) <= percent + 0.0001) matched = band;
        }
        gradeInfo = matched || sorted.find((b: any) => String(b.status).toUpperCase() === 'FAIL') || sorted[0];
      }

      return {
        studentId: mark.studentId,
        subjectId: resolvedSubjectId,
        written,
        mcq,
        practical,
        totalMarks,
        grade: gradeInfo?.grade || 'F',
        gp: gradeInfo?.gp || 0,
      };
    });

    // Save marks for each student. Total/grade/gp are always computed on the
    // server; client-supplied derived values are ignored.
    const savedMarks = await prisma.$transaction(async (tx) => {
      const saved: any[] = [];
      for (const row of normalized) {
        saved.push(await tx.result.upsert({
          where: {
            studentId_examId_subjectId: {
              studentId: row.studentId,
              examId: String(examId),
              subjectId: row.subjectId,
            }
          },
          update: {
            written: row.written,
            mcq: row.mcq,
            practical: row.practical,
            totalMarks: row.totalMarks,
            grade: row.grade,
            gp: row.gp,
            isAbsent: false,
          },
          create: {
            studentId: row.studentId,
            examId: String(examId),
            subjectId: row.subjectId,
            written: row.written,
            mcq: row.mcq,
            practical: row.practical,
            totalMarks: row.totalMarks,
            grade: row.grade,
            gp: row.gp,
            isAbsent: false,
          }
        }));
      }

      for (const subjectId of new Set(normalized.map((r) => r.subjectId))) {
        const aggregate = await tx.result.aggregate({
          where: { examId: String(examId), subjectId, studentId: { in: [...classStudentIds] } },
          _max: { totalMarks: true },
        });
        const highest = aggregate._max.totalMarks ?? 0;
        await tx.result.updateMany({
          where: { examId: String(examId), subjectId, studentId: { in: [...classStudentIds] } },
          data: { highestMarks: highest },
        });
      }

      return saved;
    });

    res.json({ 
      success: true, 
      message: 'Marks saved successfully',
      count: savedMarks.length 
    });
  } catch (error: any) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'Marks already exist for one of these students/subjects' });
    }
    console.error('Error saving marks:', error);
    res.status(500).json({ error: 'Failed to save marks' });
  }
});

// ---------------------------------------------------------------
// Student Portal Endpoints
// ---------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Format a date for the exam-schedule card: "15 Mon Jan"
function formatCardDate(d: Date | string | number | null | undefined): string {
  if (!d) return '';
  const date = new Date(d);
  return `${date.getDate()} ${DAYS[date.getDay()]} ${MONTHS[date.getMonth()]}`;
}

// Plain date string, e.g. "2026-08-05"
function toDateStr(d: Date | string | number | null | undefined): string {
  if (!d) return '';
  const date = new Date(d);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Attendance.date is stored as UTC midnight of the day key (`new Date('YYYY-MM-DD')`).
// Date-range queries and day-key extraction against attendance.date must therefore use
// UTC boundaries/parts, otherwise servers west of UTC shift records out of range.
function utcMidnight(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

// Calendar day key in the server's LOCAL timezone, e.g. "2026-08-21".
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function attendanceDayKey(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : localDayKey(new Date(value));
}

// Canonical attendance statuses. Storage + kept titlecased so every consumer
// (admin page, teacher page, dashboards, matrix) sees one consistent value.
const ATTENDANCE_STATUSES = ['Present', 'Absent', 'Late', 'Leave'] as const;
// Normalize any stored/ingested status string to the canonical titlecase form.
// Handles legacy mixed-case values ('present', 'PRESENT', 'P', 'A', 'L', 'LV').
function normalizeAttendanceStatus(raw: unknown): string {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === 'P' || s === 'PRESENT') return 'Present';
  if (s === 'A' || s === 'ABSENT' || s === 'N/A') return 'Absent';
  if (s === 'L' || s === 'LATE') return 'Late';
  if (s === 'LV' || s === 'LEAVE' || s === 'ON LEAVE' || s === 'ON-LEAVE' || s === 'HALF-DAY' || s === 'H') return 'Leave';
  return 'Present';
}
// Same as normalizeAttendanceStatus but lowercase (teacher page expects this).
function lowerAttendanceStatus(raw: unknown): string {
  return normalizeAttendanceStatus(raw).toLowerCase();
}

/**
 * Every reachable number for an absent student, de-duplicated and in priority
 * order, so the UI can offer click-to-call without extra requests.
 *
 * Shared by `/dashboard/stats` (today) and `/dashboard/attendance/absentees`
 * (any single day) so both produce an identical payload shape.
 */
function buildAbsentStudents(rows: Array<any>): Array<any> {
  return rows
    .filter((r) => ['absent', 'a'].includes(String(r.status || '').trim().toLowerCase()))
    .map((r) => {
      const g = r.student?.guardian;
      const contacts: Array<{ label: string; name: string; phone: string }> = [];
      const seen = new Set<string>();
      const push = (label: string, name: string | null | undefined, raw: string | null | undefined) => {
        const phone = String(raw ?? '').trim();
        if (!phone) return;
        const key = phone.replace(/\s+/g, '');
        if (seen.has(key)) return;
        seen.add(key);
        contacts.push({ label, name: name || '', phone });
      };
      push('guardian', g?.guardianName, g?.guardianPhone);
      push('guardian', r.student?.guardianPhone, r.student?.guardianPhone);
      push('father', g?.fatherPhone || r.student?.fatherName, g?.fatherPhone);
      push('mother', g?.motherPhone || r.student?.motherName, g?.motherPhone);
      push('student', r.student?.name, r.student?.phone);

      return {
        id: r.student?.id || r.studentId,
        name: r.student?.name || 'Unknown',
        admissionNo: r.student?.admissionNo || '',
        avatar: r.student?.avatar || null,
        class: r.student?.class || '',
        section: r.student?.section || '',
        roll: r.student?.roll ?? 0,
        status: r.student?.status || 'Inactive',
        guardianPhone: contacts[0]?.phone || r.student?.guardianPhone || '',
        contacts
      };
    });
}

// Day key from a stored attendance date (UTC), e.g. "2026-08-21".
function utcDayKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Student routes must never trust email / studentId from the query string:
// the verified JWT is the only source of the caller's identity.
function findStudentForRequest(req: Request) {
  const user = (req as any).user;
  if (!user || user.role !== 'Student') return Promise.resolve(null);
  return prisma.student.findUnique({ where: { id: user.id } });
}

app.get('/student/dashboard', authMiddleware, authMiddleware, checkRole(['Student']), async (req: Request, res: Response) => {
  try {
    const student = await findStudentForRequest(req);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const today = new Date();
    const next30 = new Date();
    next30.setDate(next30.getDate() + 30);

    const [attendance, results, fees, classRecord, allSchedules, subjects, institute, invoices] = await Promise.all([
      prisma.attendance.findMany({ where: { studentId: student.id } }),
      prisma.result.findMany({
        where: { studentId: student.id, exam: { status: 'Published' } },
        include: { exam: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.studentFee.findMany({ where: { studentId: student.id } }),
      prisma.schoolClass.findFirst({ where: { name: student.class, section: student.section } }),
      prisma.examSchedule.findMany({
        include: { exam: true, subject: true },
        orderBy: { date: 'asc' },
      }),
      prisma.subject.findMany(),
      prisma.institute.findFirst(),
      prisma.invoice.findMany({ where: { studentId: student.id }, include: { payments: true } }),
    ]);
    const subjectName = (id: string) => subjects.find((s) => s.id === id)?.name || 'Subject';

    const currencySymbol = (code?: string | null) => {
      const map: Record<string, string> = { USD: '$', BDT: 'Tk.', GBP: 'Â£', EUR: 'â‚¬', INR: 'â‚¹', PKR: 'Rs.', USD2: '$ ' };
      if (code && map[code.toUpperCase()]) return map[code.toUpperCase()];
      return code ? `${code} ` : '$';
    };
    const cur = currencySymbol(institute?.currency);

    // Exam schedules relevant to this student's class (or the whole school).
    const schedules = allSchedules.filter(
      (s) => (classRecord && s.classId === classRecord.id) || s.classId === null
    );

    const present = attendance.filter((a) => normalizeAttendanceStatus(a.status) === 'Present').length;
    const total = attendance.length;
    const attendancePct = total ? Math.round((present / total) * 100) : 0;

    // Canonical fee totals: Invoice (tuition billing, paid = sum of payments) + legacy StudentFee
    const invoiceTotal = invoices.reduce((s, inv) => s + Number(inv.totalAmount), 0);
    const invoicePaid = invoices.reduce((s, inv) => {
      const paySum = inv.payments.reduce((a: number, p: any) => a + Number(p.amount), 0);
      return s + (paySum || Number((inv as any).paidAmount || 0));
    }, 0);
    const feeTotal = fees.reduce((s, f) => s + (Number(f.amount) - Number(f.discount || 0)), 0);
    const feePaid = fees.filter((f) => f.status === 'Paid').reduce((s, f) => s + (Number(f.amount) - Number(f.discount || 0)), 0);
    const totalFee = invoiceTotal + feeTotal;
    const paid = invoicePaid + feePaid;
    const due = totalFee - paid;

    const upcomingExams = schedules
      .filter((s) => new Date(s.date) >= today && new Date(s.date) <= next30)
      .map((s) => ({
        subject: s.subject.name,
        type: s.exam.name,
        date: formatCardDate(s.date),
        time: `${s.startTime} - ${s.endTime}`,
      }));

    const pendingAssignments: never[] = [];

    // Student-visible announcements (targeted to Students, or to All).
    const studentAnnouncements = await prisma.announcement.findMany({
      where: { target: { in: ['All', 'Students'] } },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
    const latestNotices = studentAnnouncements.map((a) => ({
      title: a.title,
      date: formatCardDate(a.createdAt),
      content: a.content,
    }));

    const recentResults = results.map((r) => ({
      subject: subjectName(r.subjectId),
      marks: r.totalMarks,
      grade: r.grade || 'â€”',
      gpa: r.gp ?? 0,
    }));

    const stats = [
      {
        title: 'Attendance',
        value: `${attendancePct}%`,
        description: total ? `${present}/${total} classes attended` : 'No records yet',
        bgColor: 'bg-[#007AFF]/10',
        color: 'text-[#007AFF]',
        href: '/student/attendance',
      },
      {
        title: 'Fee Status',
        value: totalFee === 0 ? 'No fees' : (due > 0 ? `${cur}${Number(due).toFixed(2)} due` : 'Paid'),
        description: totalFee === 0 ? 'No fee records yet' : `${cur}${Number(paid).toFixed(2)} paid of ${cur}${Number(totalFee).toFixed(2)}`,
        bgColor: totalFee === 0 ? 'bg-slate-50' : (due > 0 ? 'bg-red-50' : 'bg-green-100'),
        color: totalFee === 0 ? 'text-slate-400' : (due > 0 ? 'text-red-600' : 'text-green-600'),
        href: '/student/fees',
      },
      {
        title: 'Upcoming Exams',
        value: String(upcomingExams.length),
        description: 'Exams in the next 30 days',
        bgColor: 'bg-amber-50',
        color: 'text-amber-600',
        href: '/student/exam-schedule',
      },
      {
        title: 'Past Results',
        value: String(results.length),
        description: results.length ? 'Results on record' : 'No results published yet',
        bgColor: 'bg-slate-100',
        color: 'text-slate-600',
        href: '/student/results',
      },
    ];

    res.json({ stats, upcomingExams, pendingAssignments, latestNotices, recentResults });
  } catch (error) {
    console.error('Error fetching student dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

app.get('/student/profile', authMiddleware, authMiddleware, checkRole(['Student']), async (req: Request, res: Response) => {
  try {
    const student = await prisma.student.findUnique({
      where: { id: (req as any).user.id },
      include: { guardian: true },
    });

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    res.json({
      ...student,
      studentId: student.id,
      admissionNo: student.admissionNo,
      dob: student.dob ? toDateStr(student.dob) : student.dob,
      admissionDate: student.admissionDate ? toDateStr(student.admissionDate) : student.admissionDate,
      admissionYear: student.academicYear || String(student.admissionDate.getFullYear()),
      fatherPhone: student.guardian?.fatherPhone || '',
      motherPhone: student.guardian?.motherPhone || '',
      guardianName: student.guardian?.guardianName || 'N/A',
      guardianPhone: student.guardian?.guardianPhone || '',
      previousSchool: student.additionalNote || '',
    });
  } catch (error) {
    console.error('Error fetching student profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile data' });
  }
});

app.get('/student/results', authMiddleware, authMiddleware, checkRole(['Student']), async (req: Request, res: Response) => {
  try {
    const student = await findStudentForRequest(req);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const [results, subjects, schedules, allGrading, absentAttendances] = await Promise.all([
      prisma.result.findMany({
        where: { studentId: student.id, exam: { status: 'Published' } },
        include: { exam: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.subject.findMany(),
      prisma.examSchedule.findMany({ include: { exam: true, subject: true, class: true } }),
      prisma.gradingSystem.findMany(),
      prisma.examAttendance.findMany({
        where: { studentId: student.id, status: 'ABSENT', exam: { status: 'Published' } },
        include: { exam: true },
      }),
    ]);
    const subjectName = (id: string) => subjects.find((s) => s.id === id)?.name || 'Subject';

    // Group results by exam so the portal shows only real exams.
    const byExam = new Map<string, any[]>();
    for (const r of results) {
      if (!byExam.has(r.examId)) byExam.set(r.examId, []);
      byExam.get(r.examId)!.push(r);
    }

    // Attendance is authoritative: surface absent subjects even when no Result
    // row was ever written for them (e.g. marks were never saved).
    for (const attendance of absentAttendances) {
      if (!byExam.has(attendance.examId)) byExam.set(attendance.examId, []);
      const list = byExam.get(attendance.examId)!;
      let existing = list.find((r) => r.subjectId === attendance.subjectId);
      if (!existing) {
        existing = {
          id: `absent-${attendance.id}`,
          studentId: student.id,
          examId: attendance.examId,
          subjectId: attendance.subjectId,
          written: 0,
          mcq: 0,
          practical: 0,
          totalMarks: 0,
          grade: 'ABSENT',
          gp: 0,
          isAbsent: true,
          exam: attendance.exam,
        };
        list.push(existing);
      } else {
        existing.isAbsent = true;
        existing.grade = 'ABSENT';
        existing.written = 0;
        existing.mcq = 0;
        existing.practical = 0;
        existing.totalMarks = 0;
        existing.gp = 0;
      }
    }

    const classmates = await prisma.student.findMany({
      where: { class: student.class, section: student.section },
      select: { id: true },
    });
    const classmateIds = classmates.map((c) => c.id);

    const round2 = (n: number) => Math.round(n * 100) / 100;

    const exams: Array<{ id: string; name: string; resultData: any[]; overall: { totalMarks: number; fullMarks: number; percentage: number; grade: string; gpa: number; rank: number; passed: boolean; isAbsent: boolean; hasAbsence: boolean } }> = [];
    for (const [examId, list] of byExam.entries()) {
      const examSchedules = schedules.filter((s) => s.examId === examId);
      const rowIsAbsent = (r: any) => !!r.isAbsent || r.grade === 'ABSENT';
      const rows = list.map((r) => {
        const sc = examSchedules.find((s) => s.subjectId === r.subjectId && s.class?.name === student.class);
        const hasMcq = Number(sc?.mcqFullMarks ?? 0) > 0 || Number(r.mcq) > 0;
        return {
          id: r.id,
          subject: subjectName(r.subjectId),
          written: r.written,
          mcq: hasMcq ? r.mcq : null,
          total: r.totalMarks,
          grade: r.grade || 'â€”',
          gpa: r.gp ?? 0,
          isAbsent: rowIsAbsent(r),
        };
      });

      const examTypeId = list[0].exam.typeId;
      const grading = allGrading
        .filter((g) => g.examTypeId === examTypeId)
        .sort((a, b) => Number(b.minPercent) - Number(a.minPercent));
      const failGrades = new Set<string>(grading.filter((g) => g.status === 'FAIL').map((g) => g.grade));

      const totalMarks = list.reduce((s, r) => s + (rowIsAbsent(r) ? 0 : (r.totalMarks || 0)), 0);
      let fullMarks = 0;
      let gpSum = 0, gpCount = 0, creditSum = 0, failed = false, hasAbsence = false;
      for (const r of list) {
        if (rowIsAbsent(r)) { hasAbsence = true; continue; }
        const sc = examSchedules.find((s) => s.subjectId === r.subjectId && s.class?.name === student.class);
        fullMarks += Number(sc?.fullMarks ?? 100);
        const ch = Number(sc?.subject?.creditHours ?? 1) || 1;
        if (r.gp != null) { gpSum += r.gp * ch; gpCount++; creditSum += ch; }
        if (r.grade && failGrades.has(r.grade)) failed = true;
      }
      // Credit-weighted GPA: Î£(GP Ã— creditHours) / Î£(creditHours). (#11)
      const avgGpa = creditSum > 0 ? round2(gpSum / creditSum) : (gpCount ? round2(gpSum / gpCount) : 0);
      const percentage = fullMarks > 0 ? round2((totalMarks / fullMarks) * 100) : 0;
      if (hasAbsence) failed = true;
      let grade = 'â€”';
      if (failed) {
        grade = 'F';
      } else if (grading.length) {
        // Rebase band bounds onto the same percentage scale as the overall
        // percentage. Bands may be stored on a marks scale (e.g. a "50 Marks"
        // template stores A+ as 40-50), so comparing the 0-100 percentage
        // directly against raw bounds misgrades every subject. (#grade-scale)
        const bandMax = Math.max(...grading.map((x) => Number(x.maxPercent) || 0));
        const asPctRef = bandMax > 0 ? bandMax : 100;
        const asPct = (v: number) => ((Number(v) || 0) / asPctRef) * 100;
        const sorted = [...grading].sort((a, b) => asPct(Number(b.minPercent)) - asPct(Number(a.minPercent)));
        let matched: any = null;
        for (const x of sorted) {
          if (asPct(Number(x.minPercent)) <= percentage + 0.0001) matched = x;
        }
        grade = (matched || sorted[sorted.length - 1])?.grade || '—';
      }

      // Rank within this exam across classmates.
      let rank = 1;
      try {
        const totals = classmateIds.length
          ? await prisma.result.groupBy({
              by: ['studentId'],
              where: { studentId: { in: classmateIds }, examId },
              _sum: { totalMarks: true },
            })
          : [];
        const myTotal = rows.reduce((s, r) => s + r.total, 0);
        const sorted = totals.map((t) => Number(t._sum?.totalMarks ?? 0)).sort((a, b) => b - a);
        rank = sorted.indexOf(myTotal) === -1 ? (sorted.length ? sorted.length + 1 : 1) : sorted.indexOf(myTotal) + 1;
      } catch (e) {
        rank = 1;
      }

      exams.push({
        id: examId,
        name: list[0].exam.name,
        resultData: rows,
        overall: {
          totalMarks,
          fullMarks,
          percentage,
          grade,
          gpa: avgGpa,
          rank,
          passed: !failed && !hasAbsence,
          isAbsent: list.every(rowIsAbsent),
          hasAbsence,
        },
      });
    }

    res.json({
      exams,
      resultData: exams.length ? exams[0].resultData : [],
      overall: exams.length ? exams[0].overall : { totalMarks: 0, fullMarks: 0, percentage: 0, grade: 'â€”', gpa: 0, rank: 1, passed: false },
    });
  } catch (error) {
    console.error('Error fetching student results:', error);
    res.status(500).json({ error: 'Failed to fetch results data' });
  }
});

app.get('/student/fees', authMiddleware, authMiddleware, checkRole(['Student']), async (req: Request, res: Response) => {
  try {
    const student = await findStudentForRequest(req);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Single source of truth: invoices + their (non-voided) payments.
    const invoices = await prisma.invoice.findMany({
      where: { studentId: student.id },
      include: { payments: true },
      orderBy: { createdAt: 'desc' },
    });

    const today = new Date();

    const invoiceTotal = invoices.reduce((s, inv) => s.plus(inv.totalAmount), money(0));
    const invoicePaid = invoices.reduce((s, inv) => s.plus(netPaid(inv.payments)), money(0));

    const feeStats = {
      totalFee: round2(invoiceTotal.toNumber()),
      paid: round2(invoicePaid.toNumber()),
      due: round2(invoiceTotal.minus(invoicePaid).toNumber()),
    };

    const normalizeStatus = (s?: string) =>
      s === 'paid' || s === 'Paid' ? 'Paid' : s === 'partial' || s === 'Partial' ? 'Partial' : 'Due';

    let currentDue = 0;
    let overdueDue = 0;

    const invoiceList = invoices.map((inv) => {
      const paid = netPaid(inv.payments);
      const balance = money(inv.totalAmount).minus(paid);
      const state = getFeeState(balance, inv.dueDate, today);
      const displayNo = inv.invoiceNo || `INV-${inv.id.slice(-8).toUpperCase()}`;
      if (balance.gt(0)) {
        if (state === 'OVERDUE') overdueDue += balance.toNumber();
        else currentDue += balance.toNumber();
      }
      return {
        id: inv.id,
        invoiceNo: displayNo,
        type: inv.type,
        date: toDateStr(inv.createdAt),
        billingMonth: inv.billingMonth ?? null,
        dueDate: inv.dueDate ? toDateStr(inv.dueDate) : null,
        amount: Number(inv.totalAmount),
        paid: paid.toNumber(),
        balance: balance.toNumber(),
        status: normalizeStatus(inv.status),
        feeState: state,
      };
    });

    res.json({
      feeStats,
      aging: {
        currentDue: round2(currentDue),
        overdueDue: round2(overdueDue),
        totalOutstanding: round2(currentDue + overdueDue),
      },
      invoices: invoiceList,
    });
  } catch (error) {
    console.error('Error fetching student fees:', error);
    res.status(500).json({ error: 'Failed to fetch fees data' });
  }
});

app.get('/student/attendance', authMiddleware, authMiddleware, checkRole(['Student']), async (req: Request, res: Response) => {
  try {
    const student = await findStudentForRequest(req);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const attendance = await prisma.attendance.findMany({
      where: { studentId: student.id },
      orderBy: { date: 'desc' },
      take: 30,
    });

    const present = attendance.filter((a) => a.status === 'Present').length;
    const total = attendance.length;

    const summary = {
      percentage: total ? Math.round((present / total) * 100) : 0,
      totalClasses: total,
      present,
      absent: attendance.filter((a) => normalizeAttendanceStatus(a.status) === 'Absent').length,
    };

    const records = attendance.map((r) => ({
      id: r.id,
      date: toDateStr(r.date),
      status: r.status,
    }));

    res.json({ summary, records });
  } catch (error) {
    console.error('Error fetching student attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance data' });
  }
});

app.get('/student/exam-schedule', authMiddleware, authMiddleware, checkRole(['Student']), async (req: Request, res: Response) => {
  try {
    const student = await findStudentForRequest(req);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const classRecord = await prisma.schoolClass.findFirst({
      where: { name: student.class, section: student.section },
    });

    const schedules = await prisma.examSchedule.findMany({
      where: classRecord ? { OR: [{ classId: classRecord.id }, { classId: null }] } : undefined,
      include: { exam: true, subject: true },
      orderBy: { date: 'asc' },
    });

    const today = new Date();

    res.json(
      schedules.map((s) => ({
        id: s.id,
        date: formatCardDate(s.date),
        examName: s.exam.name,
        subject: s.subject.name,
        time: `${s.startTime} - ${s.endTime}`,
        room: s.roomNo || 'TBA',
        status: new Date(s.date) < today ? 'Completed' : 'Upcoming',
      }))
    );
  } catch (error) {
    console.error('Error fetching exam schedule:', error);
    res.status(500).json({ error: 'Failed to fetch exam schedule' });
  }
});

// Student's own printable report card (same data as the admin report card).
app.get('/student/report-card', authMiddleware, authMiddleware, checkRole(['Student']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.query as any;
    if (!examId) return res.status(400).json({ error: 'examId is required' });
    const student = await findStudentForRequest(req);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }
    const body = await buildStudentReportCard(String(examId), student.id);
    if (!body) return res.status(404).json({ error: 'No results for this student in this exam' });
    res.json(body);
  } catch (error: any) {
    console.error('Error building student report card:', error);
    res.status(500).json({ error: 'Failed to build report card' });
  }
});

app.get('/student/notices', authMiddleware, authMiddleware, checkRole(['Student']), async (_req: Request, res: Response) => {
  try {
    const items = await prisma.announcement.findMany({
      where: { target: { in: ['All', 'Students'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(items.map((a) => ({
      id: a.id,
      title: a.title,
      content: a.content,
      category: a.target,
      date: formatCardDate(a.createdAt),
      attachment: null,
    })));
  } catch (error) {
    console.error('Error fetching notices:', error);
    res.status(500).json({ error: 'Failed to fetch notices' });
  }
});

app.get('/student/messages', authMiddleware, authMiddleware, checkRole(['Student']), async (_req: Request, res: Response) => {
  try {
    res.json({ contacts: [], messages: [] });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.get('/student/assignments', authMiddleware, authMiddleware, checkRole(['Student']), async (_req: Request, res: Response) => {
  try {
    res.json([]);
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

const port = Number(process.env.PORT) || 4000;

// Mount fees router
app.use('/fees', feesRouter);
app.use('/leaves', leavesRouter);

// Mount error handler as the last middleware (catches all errors from routes)
app.use(errorHandler);

async function ensureStudentAcademicRecordTable() {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "StudentAcademicRecord" LIMIT 1`;
    return;
  } catch {
    // Table does not exist yet â€” create it below
  }

  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "StudentAcademicRecord" (
      "id" TEXT NOT NULL,
      "studentId" TEXT NOT NULL,
      "academicYear" TEXT NOT NULL,
      "class" TEXT NOT NULL,
      "section" TEXT,
      "roll" INTEGER,
      "status" TEXT NOT NULL,
      "startDate" TIMESTAMP(3),
      "endDate" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "StudentAcademicRecord_pkey" PRIMARY KEY ("id")
    )`;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "StudentAcademicRecord_studentId_idx" ON "StudentAcademicRecord"("studentId")`;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "StudentAcademicRecord_academicYear_idx" ON "StudentAcademicRecord"("academicYear")`;
  await prisma.$executeRaw`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StudentAcademicRecord_studentId_fkey') THEN
        ALTER TABLE "StudentAcademicRecord" ADD CONSTRAINT "StudentAcademicRecord_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$;`;
  console.log('Ensured StudentAcademicRecord table exists');
}

ensureStudentAcademicRecordTable()
  .catch((error) => console.error('Failed to ensure StudentAcademicRecord table:', error))
  .finally(() => {
    app.listen(port, '0.0.0.0', () => {
      console.log(`Academify API listening on http://0.0.0.0:${port}`);
    });
  });

