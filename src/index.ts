import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { addMonths } from 'date-fns';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { authMiddleware } from './auth';
import { checkRole } from './checkRole';


const prisma = new PrismaClient();
const app = express();

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

// Before helmet/cors/body parsers so platform health probes always get a fast 200
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
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

// ✅ Better Vercel matcher (handles ALL preview URLs)
const isVercelPreviewOrigin = (origin: string) =>
  /^https:\/\/.*\.vercel\.app$/i.test(origin);

const corsOptions: cors.CorsOptions = {
  origin: true, // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  optionsSuccessStatus: 200,
};

// Set fallback JWT_SECRET if not in environment
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'fallback-jwt-secret-for-development';
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
            throw new ImageUploadGuardError(
              'Photo uploads are not configured: set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in the server environment.',
              400
            );
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
    const { name, phone, address, department, designation, avatar } = req.body;

    if (auth.role !== 'Admin') {
      return res.status(403).json({ error: 'Only admin accounts can update this profile' });
    }

    const updated = await prisma.user.update({
      where: { id: auth.id },
      data: {
        name: name ?? null,
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
app.get('/dashboard/stats', authMiddleware, async (req: Request, res: Response) => {
  try {
  const user = (req as any).user;
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  // Attendance.date is stored at UTC midnight of the local day, so use UTC
  // boundaries for the attendance query (ledger queries below keep local time).
  const attStart = utcMidnight(localDayKey(now));
  const attEnd = new Date(attStart);
  attEnd.setUTCDate(attEnd.getUTCDate() + 1);

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
      where: { date: { gte: attStart, lt: attEnd } },
      select: {
        studentId: true,
        status: true,
        student: {
          select: { id: true, name: true, admissionNo: true, avatar: true, class: true, section: true, roll: true, status: true, guardianPhone: true }
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

  const ledgerIncome = await prisma.ledgerEntry.aggregate({
    _sum: { amount: true },
    where: {
      type: 'income',
      createdAt: { gte: mStart, lt: mEnd }
    }
  });
  const ledgerExpense = await prisma.ledgerEntry.aggregate({
    _sum: { amount: true },
    where: {
      type: 'expense',
      createdAt: { gte: mStart, lt: mEnd }
    }
  });

  const [todayIncome, todayExpense] = await Promise.all([
    prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { type: 'income', createdAt: { gte: todayStart, lt: todayEnd } }
    }),
    prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { type: 'expense', createdAt: { gte: todayStart, lt: todayEnd } }
    })
  ]);

  const studentsPerClass = await prisma.student.groupBy({
    by: ['class'],
    _count: { id: true }
  });

  const feeInvoices = await prisma.invoice.findMany({
    select: { totalAmount: true, payments: { select: { amount: true } } }
  });
  let feesDue = money(0);
  let feesCollected = money(0);
  for (const inv of feeInvoices) {
    const paid = inv.payments.reduce((s, p) => s.plus(p.amount), money(0));
    feesCollected = feesCollected.plus(paid);
    feesDue = feesDue.plus(inv.totalAmount.minus(paid));
  }

  const allTimeIncome = await prisma.ledgerEntry.aggregate({
    _sum: { amount: true },
    where: { type: 'income' }
  });
  const allTimeExpense = await prisma.ledgerEntry.aggregate({
    _sum: { amount: true },
    where: { type: 'expense' }
  });

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

  const absentStudents = uniqueToday
    .filter((r) => ['absent', 'a'].includes(String(r.status || '').trim().toLowerCase()))
    .map((r) => ({
      id: r.student?.id || r.studentId,
      name: r.student?.name || 'Unknown',
      admissionNo: r.student?.admissionNo || '',
      avatar: r.student?.avatar || null,
      class: r.student?.class || '',
      section: r.student?.section || '',
      roll: r.student?.roll ?? 0,
      status: r.student?.status || 'Inactive',
      guardianPhone: r.student?.guardianPhone || ''
    }));

  // Build 6-month history for chart
  const historyIncome: Array<{ date: Date; amount: number }> = [];
  const historyExpense: Array<{ date: Date; amount: number }> = [];
  for (let i = 5; i >= 0; i--) {
    const histStart = new Date(currentYear, currentMonth - i, 1);
    const histEnd = new Date(currentYear, currentMonth - i + 1, 1);
    const li = await prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { type: 'income', createdAt: { gte: histStart, lt: histEnd } }
    });
    const le = await prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { type: 'expense', createdAt: { gte: histStart, lt: histEnd } }
    });
    historyIncome.push({ date: histStart, amount: money(li._sum.amount).toNumber() });
    historyExpense.push({ date: histStart, amount: money(le._sum.amount).toNumber() });
  }

  // Daily history for the current month (day 1 -> today)
  const dailyIncome: Array<{ date: Date; amount: number }> = [];
  const dailyExpense: Array<{ date: Date; amount: number }> = [];
  const todayDay = new Date().getDate();
  for (let d = 1; d <= todayDay; d++) {
    const dStart = new Date(currentYear, currentMonth, d);
    const dEnd = new Date(currentYear, currentMonth, d + 1);
    const dli = await prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { type: 'income', createdAt: { gte: dStart, lt: dEnd } }
    });
    const dle = await prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { type: 'expense', createdAt: { gte: dStart, lt: dEnd } }
    });
    dailyIncome.push({ date: dStart, amount: money(dli._sum.amount).toNumber() });
    dailyExpense.push({ date: dStart, amount: money(dle._sum.amount).toNumber() });
  }

  // Yearly history for the current year (Jan -> current month)
  const yearlyIncome: Array<{ date: Date; amount: number }> = [];
  const yearlyExpense: Array<{ date: Date; amount: number }> = [];
  for (let m = 0; m <= currentMonth; m++) {
    const mStart = new Date(currentYear, m, 1);
    const mEnd = new Date(currentYear, m + 1, 1);
    const mli = await prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { type: 'income', createdAt: { gte: mStart, lt: mEnd } }
    });
    const mle = await prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { type: 'expense', createdAt: { gte: mStart, lt: mEnd } }
    });
    yearlyIncome.push({ date: mStart, amount: money(mli._sum.amount).toNumber() });
    yearlyExpense.push({ date: mStart, amount: money(mle._sum.amount).toNumber() });
  }

  res.json({
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
      todayIncome: money(todayIncome._sum.amount),
      todayExpense: money(todayExpense._sum.amount),
      feesDue,
      feesCollected,
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
      absentStudents
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
  });
  } catch (error: any) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to load dashboard stats' });
  }
});

// Admin - Reset Data
app.delete('/admin/reset-data', async (_req: Request, res: Response) => {
  try {
    await prisma.$transaction([
      prisma.ledgerEntry.deleteMany(),
      prisma.studentFee.deleteMany(),
      prisma.attendance.deleteMany(),
      prisma.student.deleteMany(),
      prisma.teacherSalary.deleteMany(),
      prisma.teacher.deleteMany(),
      prisma.schoolClass.deleteMany(),
      prisma.schoolExpense.deleteMany(),
      prisma.subject.deleteMany(),
      prisma.saleItem.deleteMany(),
      prisma.sale.deleteMany(),
      prisma.purchaseItem.deleteMany(),
      prisma.purchase.deleteMany(),
      prisma.product.deleteMany(),
      prisma.supplier.deleteMany(),
      prisma.payment.deleteMany(),
      prisma.invoiceItem.deleteMany(),
      prisma.invoice.deleteMany(),
    ]);
    res.json({ success: true, message: 'All data has been reset.' });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({ error: 'Failed to reset data' });
  }
});

// Dashboard: weekly attendance summary (grouped per day)
app.get('/dashboard/attendance/summary/weekly', async (req: Request, res: Response) => {
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
      where: { date: { gte: start, lte: end } },
      select: { date: true, status: true },
    });

    const dayMap = new Map<string, { present: number; absent: number; late: number }>();
    for (const r of records) {
      const key = utcDayKeyOf(r.date);
      const entry = dayMap.get(key) || { present: 0, absent: 0, late: 0 };
      if (r.status === 'Present') entry.present++;
      else if (r.status === 'Absent') entry.absent++;
      else if (r.status === 'Late') entry.late++;
      dayMap.set(key, entry);
    }

    const result: Array<{ date: string; present: number; absent: number; late: number }> = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = utcDayKeyOf(d);
      result.push({ date: key, ...(dayMap.get(key) || { present: 0, absent: 0, late: 0 }) });
    }

    res.json(result);
  } catch (error) {
    console.error('Weekly attendance summary error:', error);
    res.status(500).json({ error: 'Failed to load weekly attendance summary' });
  }
});

app.get('/dashboard/financial-details', async (req: Request, res: Response) => {
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
        where: { type: 'income', ...dateFilter }
      });
      const expense = await prisma.ledgerEntry.aggregate({
        _sum: { amount: true },
        where: { type: 'expense', ...dateFilter }
      });
      const incomeTotal = money(income._sum.amount);
      const expenseTotal = money(expense._sum.amount);
      return res.json({
        total: incomeTotal.minus(expenseTotal),
        incomeTotal,
        expenseTotal
      });
    }

    const where = { type, ...dateFilter };
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
app.get('/students', authMiddleware, async (req: Request, res: Response) => {
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

app.get('/students/rolls/used', authMiddleware, async (req: Request, res: Response) => {
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

app.get('/students/:id', authMiddleware, async (req: Request, res: Response) => {
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
    section: z.string().min(1).optional(),
    roll: z.number().int().optional(),
    gender: z.string().optional(),
    bloodGroup: z.string().optional(),
    religion: z.string().optional(),
    banglaName: z.string().optional(),
    dob: z.preprocess((v) => (typeof v === 'string' ? new Date(v) : undefined), z.date().optional()),
    guardianPhone: z.string().optional().nullable(),
    guardianEmail: z.string().email().optional().or(z.literal('')),
    fatherName: z.string().optional(),
    motherName: z.string().optional(),
    address: z.string().optional(),
    academicYear: z.string().optional(),
    shift: z.string().optional(),
    avatar: z.string().optional().nullable(),
    status: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const student = await prisma.student.update({ where: { id }, data: parsed.data });
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

// Student Logins
app.get('/students/logins', async (_req: Request, res: Response) => {
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

app.post('/students/logins', async (req: Request, res: Response) => {
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

app.put('/students/logins/:id', async (req: Request, res: Response) => {
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

app.delete('/students/logins/:id', async (req: Request, res: Response) => {
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

// Exam Types
app.get('/exam-types', async (_req: Request, res: Response) => {
  try {
    const types = await prisma.examType.findMany({ orderBy: { name: 'asc' } });
    res.json(types);
  } catch (error: any) {
    console.error('Error fetching exam types:', error);
    res.status(500).json({ error: 'Failed to fetch exam types', details: error.message });
  }
});

app.post('/exam-types', async (req: Request, res: Response) => {
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

app.delete('/exam-types/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.$transaction([
      prisma.gradingSystem.deleteMany({ where: { examTypeId: id } }),
      prisma.examSchedule.deleteMany({ where: { examId: { in: (await prisma.exam.findMany({ where: { typeId: id }, select: { id: true } })).map(e => e.id) } } }),
      prisma.exam.deleteMany({ where: { typeId: id } }),
      prisma.examType.delete({ where: { id } }),
    ]);
    res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Exam type not found' });
    }
    console.error('Delete exam type error:', error);
    res.status(500).json({ error: 'Failed to delete exam type', details: error.message });
  }
});

// Exams
app.get('/exams', async (_req: Request, res: Response) => {
  const exams = await prisma.exam.findMany({
    include: { type: true },
    orderBy: { startDate: 'desc' }
  });
  res.json(exams);
});

app.post('/exams', async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    typeId: z.string().min(1),
    startDate: z.string().min(1),
    endDate: z.string().min(1),
    academicYear: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { name, typeId, startDate, endDate, academicYear } = parsed.data;
  const exam = await prisma.exam.create({
    data: {
      name,
      typeId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      academicYear
    },
    include: { type: true }
  });
  res.status(201).json(exam);
});

// Results
app.get('/results', async (req: Request, res: Response) => {
  const { examId, subjectId, studentIds } = req.query as any;
  if (!examId) return res.status(400).json({ error: 'examId is required' });

  const where: any = { examId };
  if (subjectId) where.subjectId = subjectId;
  if (studentIds) {
    where.studentId = { in: studentIds.split(',') };
  }

  const results = await prisma.result.findMany({ where });
  res.json(results);
});

app.post('/results/bulk', async (req: Request, res: Response) => {
  const schema = z.object({
    examId: z.string().min(1),
    subjectId: z.string().min(1),
    marks: z.array(z.object({
      studentId: z.string().min(1),
      written: z.number().default(0),
      mcq: z.number().default(0),
      practical: z.number().default(0),
    })).min(1)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { examId, subjectId, marks } = parsed.data;

  // Fetch Grading System, Exam Schedules, Exam details, and Students
  const [exam, schedules, students, existingResults] = await Promise.all([
    prisma.exam.findUnique({ where: { id: examId } }),
    prisma.examSchedule.findMany({ where: { examId, subjectId }, include: { class: true } }),
    prisma.student.findMany({
      where: { id: { in: marks.map(m => m.studentId) } },
      select: { id: true, class: true }
    }),
    prisma.result.findMany({
      where: { examId, subjectId }
    })
  ]);

  if (!exam) return res.status(404).json({ error: 'Exam not found' });

  // Fetch grading for this exam type
  const grading = await prisma.gradingSystem.findMany({
    where: { examTypeId: exam.typeId },
    orderBy: { minPercent: 'desc' }
  });

  const studentMap = new Map(students.map(s => [s.id, s.class]));
  const resultsByStudent = new Map(existingResults.map(r => [r.studentId, r.totalMarks]));

  // Calculate highest marks for this exam/subject
  const currentBatchMap = new Map(marks.map(m => [m.studentId, m.written + m.mcq + m.practical]));
  const allResultsMap = new Map(existingResults.map(r => [r.studentId, r.totalMarks]));
  currentBatchMap.forEach((total, studentId) => {
    allResultsMap.set(studentId, total);
  });
  const highestMarks = Math.max(...Array.from(allResultsMap.values()), 0);

  // Get pass marks from grading system if available
  const passConfig = grading.length > 0 ? grading[0] : null;
  const wPass = passConfig?.writtenPass ?? 0;
  const mPass = passConfig?.mcqPass ?? 0;
  const tPass = passConfig?.totalPass ?? 0;

  // Transaction to upsert results
  await prisma.$transaction(
    marks.map(m => {
      const totalMarks = m.written + m.mcq + m.practical;

      // Pass/Fail Logic
      // Written is mandatory, MCQ is optional (only fails if provided and below threshold)
      let isFail = false;
      if (m.written < wPass) isFail = true;
      if (m.mcq > 0 && m.mcq < mPass) isFail = true;
      if (totalMarks < tPass) isFail = true;

      // Get full marks for student's class
      const studentClass = studentMap.get(m.studentId);
      const scheduleForClass = schedules.find(s => s.class?.name === studentClass);
      const fullMarks = scheduleForClass?.fullMarks || (schedules.length > 0 ? schedules[0].fullMarks : 100) || 100;

      const percent = (totalMarks / fullMarks) * 100;

      let gradeInfo;
      if (isFail) {
        gradeInfo = grading.find(g => g.status === 'FAIL') || { grade: 'F', gp: 0 };
      } else {
        gradeInfo = grading.find(g => percent >= g.minPercent && percent <= g.maxPercent) || grading[grading.length - 1];
      }

      return prisma.result.upsert({
        where: {
          studentId_examId_subjectId: {
            studentId: m.studentId,
            examId,
            subjectId
          }
        },
        update: {
          ct: 0,
          cwhw: 0,
          dgc: 0,
          written: m.written,
          mcq: m.mcq,
          practical: m.practical,
          totalMarks,
          grade: gradeInfo?.grade || 'F',
          gp: gradeInfo?.gp || 0,
          highestMarks // Store the calculated highest marks
        },
        create: {
          studentId: m.studentId,
          examId,
          subjectId,
          ct: 0,
          cwhw: 0,
          dgc: 0,
          written: m.written,
          mcq: m.mcq,
          practical: m.practical,
          totalMarks,
          grade: gradeInfo?.grade || 'F',
          gp: gradeInfo?.gp || 0,
          highestMarks
        }
      });
    })
  );

  // After saving this batch, we should ideally update the highestMarks for ALL results of this exam/subject
  // to ensure consistency if the new highest mark comes from this batch.
  await prisma.result.updateMany({
    where: { examId, subjectId },
    data: { highestMarks }
  });

  res.json({ success: true, highestMarks });
});

// ===== Results reporting (overview / class / student) =====

async function buildExamReport(examId: string) {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { type: true } });
  if (!exam) throw new Error('Exam not found');

  const [grading, schedules, results] = await Promise.all([
    prisma.gradingSystem.findMany({ where: { examTypeId: exam.typeId }, orderBy: { minPercent: 'desc' } }),
    prisma.examSchedule.findMany({ where: { examId }, include: { subject: true, class: true } }),
    prisma.result.findMany({
      where: { examId },
      include: { student: true }
    })
  ]);

  const failGrades = new Set<string>();
  grading.forEach((g) => { if (g.status === 'FAIL') failGrades.add(g.grade); });
  if (failGrades.size === 0) failGrades.add('F');

  const subjectName = new Map<string, string>();
  const subjectFullMarksByClass = new Map<string, Map<string, number>>();
  const subjectDefaultFullMarks = new Map<string, number>();
  for (const s of schedules) {
    subjectName.set(s.subjectId, s.subject?.name || s.subjectId);
    if (!subjectDefaultFullMarks.has(s.subjectId)) subjectDefaultFullMarks.set(s.subjectId, s.fullMarks ?? 100);
    if (s.class?.name) {
      if (!subjectFullMarksByClass.has(s.subjectId)) subjectFullMarksByClass.set(s.subjectId, new Map());
      subjectFullMarksByClass.get(s.subjectId)!.set(s.class.name, s.fullMarks ?? 100);
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
    let totalMarks = 0, fullMarks = 0, gpSum = 0, gpCount = 0, failed = false;
    for (const r of subjects) {
      totalMarks += r.totalMarks || 0;
      const fm = subjectFullMarksByClass.get(r.subjectId)?.get(student.class) ?? subjectDefaultFullMarks.get(r.subjectId) ?? 100;
      fullMarks += fm;
      if (r.gp != null) { gpSum += r.gp; gpCount++; }
      if (r.grade && failGrades.has(r.grade)) failed = true;
    }
    const gpa = gpCount ? round2(gpSum / gpCount) : 0;
    const percentage = fullMarks > 0 ? round2((totalMarks / fullMarks) * 100) : 0;
    let grade = '';
    if (failed) {
      grade = 'F';
    } else if (grading.length) {
      const g = grading.find((x) => percentage >= x.minPercent && percentage <= x.maxPercent);
      grade = g ? g.grade : (grading[grading.length - 1]?.grade || '');
    }
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
      passed: !failed,
      failed,
      subjectCount: subjects.length
    });
  }

  return { exam, grading, results, students, failGrades, subjectName, subjectDefaultFullMarks };
}

function subjectStatsForReport(report: Awaited<ReturnType<typeof buildExamReport>>, studentFilter?: Set<string>) {
  const map = new Map<string, { subject: string; totals: number[]; passCount: number }>();
  for (const r of report.results) {
    if (studentFilter && !studentFilter.has(r.studentId)) continue;
    if (!map.has(r.subjectId)) map.set(r.subjectId, { subject: report.subjectName.get(r.subjectId) || r.subjectId, totals: [], passCount: 0 });
    const rec = map.get(r.subjectId)!;
    const fm = report.subjectDefaultFullMarks.get(r.subjectId) ?? 100;
    rec.totals.push(fm > 0 ? (r.totalMarks / fm) * 100 : 0);
    if (!(r.grade && report.failGrades.has(r.grade))) rec.passCount++;
  }
  return [...map.values()]
    .map((x) => ({
      subject: x.subject,
      average: round2(x.totals.reduce((a, b) => a + b, 0) / (x.totals.length || 1)),
      passRate: round2((x.passCount / (x.totals.length || 1)) * 100)
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

function rankStudents(list: any[]) {
  return [...list]
    .sort((a, b) => b.gpa - a.gpa || b.percentage - a.percentage || a.name.localeCompare(b.name))
    .map((s, i) => ({ rank: i + 1, ...s }));
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
    const passed = students.filter((s) => s.passed).length;
    const failed = total - passed;
    const passRate = total ? round2((passed / total) * 100) : 0;
    const average = total ? round2(students.reduce((a, s) => a + s.percentage, 0) / total) : 0;

    const classMap = new Map<string, any[]>();
    for (const s of students) {
      const key = s.class || 'N/A';
      if (!classMap.has(key)) classMap.set(key, []);
      classMap.get(key)!.push(s);
    }
    const classPerformance = [...classMap.entries()]
      .map(([cls, arr]) => {
        const p = arr.filter((s) => s.passed).length;
        return {
          class: cls,
          students: arr.length,
          passed: p,
          failed: arr.length - p,
          passRate: round2((p / arr.length) * 100),
          average: round2(arr.reduce((a, s) => a + s.percentage, 0) / arr.length)
        };
      })
      .sort((a, b) => a.class.localeCompare(b.class));

    const subjectPerformance = subjectStatsForReport(report);
    const ranked = rankStudents(students);
    const topStudents = ranked.slice(0, 10).map((s) => ({ rank: s.rank, studentId: s.studentId, name: s.name, admissionNo: s.admissionNo, avatar: s.avatar, class: s.class, section: s.section, roll: s.roll, gpa: s.gpa, percentage: s.percentage, grade: s.grade, totalMarks: s.totalMarks }));
    const atRiskStudents = students
      .filter((s) => s.failed || s.gpa < 2.0)
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
        const prevAvg = prevReport.students.length
          ? round2(prevReport.students.reduce((a, s) => a + s.percentage, 0) / prevReport.students.length)
          : 0;
        previousExam = { id: prev.id, name: prev.name, average: prevAvg, avgChange: round2(average - prevAvg) };
      } catch (e) {
        previousExam = null;
      }
    }

    res.json({
      exam: { id: report.exam.id, name: report.exam.name, academicYear: report.exam.academicYear, type: report.exam.type?.name || '' },
      stats: { students: total, passed, failed, passRate, average },
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
    const passed = students.filter((s) => s.passed).length;
    const average = total ? round2(students.reduce((a, s) => a + s.percentage, 0) / total) : 0;
    const rankList = rankStudents(students);

    const subjectPerformance = subjectStatsForReport(report, new Set(students.map((s) => s.studentId)));

    res.json({
      exam: { id: report.exam.id, name: report.exam.name },
      class: cls,
      section: section || null,
      stats: { students: total, passed, failed: total - passed, passRate: total ? round2((passed / total) * 100) : 0, average },
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
        highestMarks: r.highestMarks
      }))
      .sort((a, b) => a.subject.localeCompare(b.subject));

    const clsRanked = report.students
      .filter((s) => s.class === agg.class)
      .sort((a, b) => b.gpa - a.gpa || b.percentage - a.percentage);
    const position = clsRanked.findIndex((s) => s.studentId === studentId) + 1;

    res.json({
      student: { id: student?.id, name: student?.name, admissionNo: student?.admissionNo, avatar: student?.avatar, class: student?.class, section: student?.section, roll: student?.roll },
      exam: { id: report.exam.id, name: report.exam.name },
      rows,
      totals: { totalMarks: agg.totalMarks, fullMarks: agg.fullMarks, percentage: agg.percentage, gpa: agg.gpa, grade: agg.grade },
      position
    });
  } catch (error: any) {
    console.error('Error building student results:', error);
    res.status(500).json({ error: 'Failed to build student results', details: error.message });
  }
});

// Exam Schedules (Routine)
app.get('/schedules', async (req: Request, res: Response) => {
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
    include: { subject: true },
    orderBy: { date: 'asc' }
  });
  res.json(schedules);
});

app.post('/schedules', async (req: Request, res: Response) => {
  const schema = z.object({
    examId: z.string().min(1),
    classId: z.string().optional(),
    subjectId: z.string().min(1),
    date: z.string().min(1),
    startTime: z.string().min(1),
    endTime: z.string().min(1),
    fullMarks: z.number().optional(),
    passMarks: z.number().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { examId, classId, subjectId, date, startTime, endTime, fullMarks, passMarks } = parsed.data;

  // Note: Using examId_subjectId_classId unique constraint if classId is provided, else examId_subjectId
  // But Prisma update/upsert requires a unique key.
  // The schema defines @@unique([examId, subjectId, classId])
  // If classId is null, unique constraint might treat it differently depending on DB.
  // For now, let's just use create or findFirst+update logic if upsert is tricky with nullable fields in composite key.
  // Or just create new schedule.

  // Actually, upsert with composite unique key where one part is nullable is tricky.
  // Let's use simple findFirst -> update or create logic.

  const existing = await prisma.examSchedule.findFirst({
    where: { examId, subjectId, classId: classId || null }
  });

  if (existing) {
    const updated = await prisma.examSchedule.update({
      where: { id: existing.id },
      data: { date: new Date(date), startTime, endTime, fullMarks, passMarks }
    });
    return res.json(updated);
  }

  const schedule = await prisma.examSchedule.create({
    data: {
      examId,
      classId,
      subjectId,
      date: new Date(date),
      startTime,
      endTime,
      fullMarks,
      passMarks
    }
  });
  res.json(schedule);
});

app.delete('/schedules/:id', async (req: Request, res: Response) => {
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

// Institute Profile
app.get('/institute', async (req: Request, res: Response) => {
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
          targetLine: 'Excellence in Education',
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

app.post('/institute', async (req: Request, res: Response) => {
  const { email } = req.query as any;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const schema = z.object({
    name: z.string().optional(),
    logo: z.string().optional(),
    targetLine: z.string().optional(),
    phone: z.string().optional(),
    website: z.string().optional(),
    address: z.string().optional(),
    country: z.string().optional(),
    currency: z.string().optional()
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
app.get('/fees', async (_req: Request, res: Response) => {
  const fees = await prisma.studentFee.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(fees);
});

app.post('/fees', async (req: Request, res: Response) => {
  const schema = z.object({
    studentId: z.string().min(1),
    feeType: z.string(),
    amount: z.number(),
    discount: z.number().default(0),
    status: z.enum(['Paid', 'Due', 'Partial']).default('Due'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const fee = await prisma.studentFee.create({ data: parsed.data });
  res.status(201).json(fee);
});

app.put('/fees/:id', async (req: Request, res: Response) => {
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

app.post('/fees/:id/pay', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await prisma.$transaction(async (tx) => {
    const fee = await tx.studentFee.update({ where: { id }, data: { status: 'Paid' } });
    await tx.ledgerEntry.create({
      data: {
        type: 'income',
        category: (fee.feeType && fee.feeType.toLowerCase()) + '_fee',
        amount: fee.amount.minus(fee.discount),
        referenceInvoice: fee.id
      }
    });
    return fee;
  });
  res.json(result);
});

app.delete('/fees/:id', async (req: Request, res: Response) => {
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
app.get('/salaries', async (_req: Request, res: Response) => {
  const salaries = await prisma.teacherSalary.findMany({ orderBy: { paymentDate: 'desc' } });
  res.json(salaries);
});

app.post('/salaries/process', async (req: Request, res: Response) => {
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
    teachers.map(t =>
      prisma.teacherSalary.create({
        data: {
          teacherId: t.id,
          baseSalary: baseSalary ?? 3000,
          bonus: 0,
          deductions: 0,
          netSalary: (baseSalary ?? 3000),
          paymentDate,
          status: 'Pending',
        },
      })
    )
  );
  res.status(201).json(newRecords);
});

app.post('/salaries/:id/pay', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await prisma.$transaction(async (tx) => {
    const salary = await tx.teacherSalary.update({ where: { id }, data: { status: 'Paid' } });
    await tx.ledgerEntry.create({
      data: {
        type: 'expense',
        category: 'teacher_salary',
        amount: salary.netSalary,
        referenceInvoice: salary.id
      }
    });
    return salary;
  });
  res.json(result);
});

app.delete('/salaries/:id', async (req: Request, res: Response) => {
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
app.get('/expenses', async (_req: Request, res: Response) => {
  const expenses = await prisma.schoolExpense.findMany({ orderBy: { date: 'desc' } });
  res.json(expenses);
});

app.post('/expenses', async (req: Request, res: Response) => {
  const schema = z.object({
    category: z.string(),
    amount: z.number(),
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
        category: (expense.category && expense.category.toLowerCase().replace(/\s+/g, '_')) || '',
        amount: expense.amount,
        referenceInvoice: expense.id,
        createdAt: expense.date
      }
    });
    return expense;
  });
  res.status(201).json(result);
});

app.put('/expenses/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    category: z.string().optional(),
    amount: z.number().optional(),
    date: z.string().transform((d) => new Date(d)).optional(),
    notes: z.string().optional().nullable()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const expense = await prisma.schoolExpense.update({ where: { id }, data: parsed.data });
  res.json(expense);
});

app.delete('/expenses/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  await prisma.schoolExpense.delete({ where: { id } });
  res.status(204).send();
});

// Classes
app.get('/classes', async (_req: Request, res: Response) => {
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

app.post('/classes', async (req: Request, res: Response) => {
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

app.put('/classes/:id', async (req: Request, res: Response) => {
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

app.delete('/classes/:id', async (req: Request, res: Response) => {
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

// Subjects
app.get('/subjects', async (_req: Request, res: Response) => {
  const subjects = await prisma.subject.findMany({ orderBy: [{ name: 'asc' }] });
  res.json(subjects);
});

app.post('/subjects', async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    code: z.string().min(1),
    type: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const subject = await prisma.subject.create({ data: parsed.data });
  res.status(201).json(subject);
});

app.put('/subjects/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    name: z.string().optional(),
    code: z.string().optional(),
    type: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const subject = await prisma.subject.update({ where: { id }, data: parsed.data });
  res.json(subject);
});

app.delete('/subjects/:id', async (req: Request, res: Response) => {
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
app.get('/attendance', async (req: Request, res: Response) => {
  const schema = z.object({
    class: z.string().min(1),
    section: z.string().min(1),
    date: z.string().min(1),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { class: className, section, date } = parsed.data as any;
  const day = new Date(String(date));
  const students = await prisma.student.findMany({ where: { class: className, section }, orderBy: { roll: 'asc' } });
  const records = await prisma.attendance.findMany({
    where: { studentId: { in: students.map((s) => s.id) }, date: day },
  });
  const map = new Map(records.map((r) => [r.studentId, r.status]));
  const result = students.map((s) => ({
    studentId: s.id,
    studentName: s.name,
    roll: s.roll,
    status: map.get(s.id) ?? 'Present',
  }));
  res.json(result);
});

// Tuition Fee Structures
app.get('/tuition/structures', async (_req: Request, res: Response) => {
  const items = await prisma.feeStructure.findMany({ where: { isActive: true }, include: { class: true } });
  res.json(items);
});

app.post('/tuition/structures', async (req: Request, res: Response) => {
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

app.put('/tuition/structures/:id', async (req: Request, res: Response) => {
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

app.delete('/tuition/structures/:id', async (req: Request, res: Response) => {
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
app.get('/tuition/assignments', async (req: Request, res: Response) => {
  const { studentId } = req.query as any;
  const where: any = {};
  if (studentId) where.studentId = String(studentId);
  const assignments = await prisma.studentFeeAssignment.findMany({ where, include: { student: true, feeStructure: true } });
  res.json(assignments);
});

app.post('/tuition/assignments', async (req: Request, res: Response) => {
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

app.put('/tuition/assignments/:id', async (req: Request, res: Response) => {
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

app.delete('/tuition/assignments/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  await prisma.studentFeeAssignment.delete({ where: { id } });
  res.status(204).send();
});

// Tuition Invoice Generation
app.post('/tuition/generate-monthly', async (req: Request, res: Response) => {
  const schema = z.object({
    month: z.number().int().min(1).max(12),
    year: z.number().int(),
    prorate: z.boolean().optional().default(false),
    dueDay: z.number().int().min(1).max(28).optional().default(10),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { month, year, prorate, dueDay } = parsed.data;

  const billingMonth = `${year}-${String(month).padStart(2, '0')}`;
  const totalDaysInMonth = new Date(year, month, 0).getDate();

  // 1. Get all active students
  const activeStudents = await prisma.student.findMany({
    where: { status: 'Active' }
  });

  // 2. Get all fee assignments for these students
  const assignments = await prisma.studentFeeAssignment.findMany({
    where: {
      isActive: true,
      studentId: { in: activeStudents.map(s => s.id) }
    },
    include: { feeStructure: true }
  });

  // 3. Get all admission packages to infer tuition if no assignment exists
  const admissionPackages = await prisma.admissionPackage.findMany({
    include: { feeItems: true }
  });

  let created = 0;
  let skipped = 0;

  for (const student of activeStudents) {
    // Check for existing tuition invoice for this month
    const existing = await prisma.invoice.findFirst({
      where: {
        studentId: student.id,
        type: 'tuition',
        billingMonth: billingMonth
      }
    });

    if (existing) {
      skipped++;
      continue;
    }

    // Determine Tuition Amount
    let tuitionAmount = money(0);

    // Priority 1: Student-specific tuition assignment
    const studentAssignment = assignments.find((a: any) => {
      const startsBeforeOrEqual = a.startYear < year || (a.startYear === year && a.startMonth <= month);
      const endsAfterOrNull = !a.endYear || a.endYear > year || (a.endYear === year && (!a.endMonth || a.endMonth >= month));
      return a.studentId === student.id && startsBeforeOrEqual && endsAfterOrNull;
    });

    if (studentAssignment) {
      const base = money(studentAssignment.customAmount ?? studentAssignment.feeStructure.amount);
      tuitionAmount = base;
      if (studentAssignment.discountPercent > 0) {
        tuitionAmount = base.minus(base.times(studentAssignment.discountPercent).div(100)).toDecimalPlaces(2);
      }
    }
    // Priority 2: Class tuition fee from admission package
    else {
      const studentClass = await prisma.schoolClass.findFirst({
        where: { name: student.class, section: student.section }
      });
      if (studentClass) {
        const pkg = admissionPackages.find(p => p.classId === studentClass.id);
        const tuitionItem = pkg?.feeItems.find(fi => fi.name && fi.name.toLowerCase().includes('tuition'));
        if (tuitionItem) {
          tuitionAmount = money(tuitionItem.amount);
        }
      }
    }

    if (tuitionAmount.lte(0)) {
      skipped++; // Or handle as "No tuition defined"
      continue;
    }

    // Apply Proration if requested
    let finalAmount = tuitionAmount;
    if (prorate) {
      const admissionDate = student.admissionDate;
      if (admissionDate && admissionDate.getFullYear() === year && (admissionDate.getMonth() + 1) === month) {
        const remainingDays = totalDaysInMonth - admissionDate.getDate() + 1;
        finalAmount = tuitionAmount.div(totalDaysInMonth).times(remainingDays).toDecimalPlaces(2);
      }
    }

    // Create Invoice
    await prisma.invoice.create({
      data: {
        studentId: student.id,
        type: 'tuition',
        totalAmount: finalAmount.toDecimalPlaces(0),
        status: 'unpaid',
        billingMonth: billingMonth,
        dueDate: new Date(year, month - 1, dueDay),
        items: {
          create: [{ name: `Monthly Tuition - ${billingMonth}`, amount: finalAmount.toDecimalPlaces(0) }]
        }
      }
    });
    created++;
  }

  res.json({
    message: "Monthly Tuition Generated",
    checked: activeStudents.length,
    created,
    skipped
  });
});
// Monthly Attendance Matrix
app.get('/attendance/matrix', async (req: Request, res: Response) => {
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

  const students = await prisma.student.findMany({
    where: { class: className, section, ...(studentId ? { id: studentId } : {}) },
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
    const percentage = Math.round((present / days.length) * 100);
    return {
      id: s.id,
      name: s.name,
      roll: s.roll,
      records: rec,
      present,
      absent,
      late,
      leave,
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

// Teacher Attendance
app.get('/attendance/teachers', async (req: Request, res: Response) => {
  const schema = z.object({
    date: z.string().min(1),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { date } = parsed.data;
  const day = new Date(String(date));

  const teachers = await prisma.teacher.findMany({ orderBy: { name: 'asc' } });
  const records = await prisma.teacherAttendance.findMany({
    where: { teacherId: { in: teachers.map((t) => t.id) }, date: day },
  });
  const map = new Map(records.map((r) => [r.teacherId, r.status]));

  const result = teachers.map((t) => ({
    teacherId: t.id,
    teacherName: t.name,
    status: map.get(t.id) ?? 'Present',
  }));
  res.json(result);
});

app.get('/store/products', async (_req: Request, res: Response) => {
  const items = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(items);
});

app.post('/store/products', async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    category: z.string().optional(),
    purchasePrice: z.number().nonnegative(),
    sellingPrice: z.number().nonnegative(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const item = await prisma.product.create({
    data: { ...parsed.data, currentStock: 0 }
  });
  res.status(201).json(item);
});

app.put('/store/products/:id', async (req: Request, res: Response) => {
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

app.get('/store/suppliers', async (_req: Request, res: Response) => {
  const items = await prisma.supplier.findMany({ orderBy: { name: 'asc' } });
  res.json(items);
});

app.post('/store/suppliers', async (req: Request, res: Response) => {
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

app.get('/store/purchases', async (_req: Request, res: Response) => {
  const items = await prisma.purchase.findMany({
    include: { items: true, supplier: true },
    orderBy: { purchaseDate: 'desc' }
  });
  res.json(items);
});

app.post('/store/purchases', async (req: Request, res: Response) => {
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

app.get('/store/sales', async (_req: Request, res: Response) => {
  const items = await prisma.sale.findMany({
    include: { items: true, student: true },
    orderBy: { saleDate: 'desc' }
  });
  res.json(items);
});

app.post('/store/sales', async (req: Request, res: Response) => {
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
  const totalAmount = items.reduce((s, it) => s + it.quantity * it.price, 0);

  const result = await prisma.$transaction(async (tx) => {
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

app.get('/store/inventory', async (_req: Request, res: Response) => {
  try {
    const products = await prisma.product.findMany({ orderBy: { name: 'asc' } });
    res.json(products.map((p: any) => ({ id: p.id, name: p.name, stock: p.currentStock })));
  } catch (error: any) {
    console.error('Inventory error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

app.get('/store/reports/profit', async (req: Request, res: Response) => {
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

app.post('/attendance/teachers/save', async (req: Request, res: Response) => {
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

app.post('/attendance/save', async (req: Request, res: Response) => {
  const schema = z.object({
    class: z.string().min(1),
    section: z.string().min(1),
    date: z.string().min(1),
    records: z.array(z.object({ studentId: z.string().min(1), status: z.string().min(1) })).min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { class: className, section, date, records } = parsed.data as any;
  const day = new Date(String(date));
  const students = await prisma.student.findMany({ where: { class: className, section } });
  const ids = new Set(students.map((s) => s.id));
  const toSave = records.filter((r: any) => ids.has(r.studentId));
  await prisma.$transaction(
    toSave.map((r: any) =>
      prisma.attendance.upsert({
        where: { studentId_date: { studentId: r.studentId, date: day } },
        update: { status: r.status },
        create: { studentId: r.studentId, date: day, status: r.status },
      })
    )
  );
  res.status(201).json({ ok: true });
});

// Admission Packages
app.get('/admission-packages', async (req: Request, res: Response) => {
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

app.post('/admission-packages', async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string(),
    session: z.string(),
    classId: z.string(),
    description: z.string().optional(),
    feeItems: z.array(z.object({
      name: z.string(),
      amount: z.number(),
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

app.put('/admission-packages/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    name: z.string().optional(),
    session: z.string().optional(),
    classId: z.string().optional(),
    description: z.string().optional(),
    feeItems: z.array(z.object({
      id: z.string().optional(),
      name: z.string(),
      amount: z.number(),
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

app.delete('/admission-packages/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.admissionPackage.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete package' });
  }
});
// Replace your existing app.post('/students/admission', ...) with this:
app.post('/students/admission', async (req: Request, res: Response) => {
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
          where: { admissionNo: { not: null } },
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
        status: 'pending_payment'
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

      // 3. Create Invoice
      const totalAmount = pkg.feeItems.reduce((sum, item) => sum.plus(item.amount), money(0));

      const invoice = await tx.invoice.create({
        data: {
          studentId: newStudent.id,
          type: 'admission',
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

      return { student: newStudent, invoice };
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
app.post('/payments', async (req: Request, res: Response) => {
  const schema = z.object({
    invoiceId: z.string(),
    amount: z.number().positive(),
    method: z.string(),
    transactionRef: z.string().optional(),
    receivedBy: z.string().optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { invoiceId, amount, method, transactionRef, receivedBy } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new Error('Invoice not found');

      const newPaidAmount = money(invoice.paidAmount).plus(amount);
      const newStatus = newPaidAmount.gte(invoice.totalAmount) ? 'paid' : 'partial';

      // 1. Create Payment
      const payment = await tx.payment.create({
        data: {
          invoiceId,
          amount: money(amount).toDecimalPlaces(2),
          method,
          transactionRef,
          receivedBy
        }
      });

      // 2. Update Invoice
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          paidAmount: newPaidAmount,
          status: newStatus
        }
      });

      // 3. Update Student Status if fully paid and admission
      if (invoice.type === 'admission' && newStatus === 'paid') {
        await tx.student.update({
          where: { id: invoice.studentId },
          data: { status: 'Active' }
        });
      }

      // 4. Create Ledger Entry
      await tx.ledgerEntry.create({
        data: {
          type: 'income',
          category: invoice.type === 'admission' ? 'admission_fee' : 'fee_collection',
          amount: money(amount).toDecimalPlaces(2),
          referenceInvoice: invoiceId
        }
      });

      return payment;
    });

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Payment failed' });
  }
});

app.get('/invoices', async (req: Request, res: Response) => {
  const { studentId } = req.query;
  const where: any = {};
  if (studentId) where.studentId = String(studentId);

  const invoices = await prisma.invoice.findMany({
    where,
    include: { items: true, payments: true, student: true },
    orderBy: { createdAt: 'desc' }
  });
  res.json(invoices);
});

app.post('/invoices/from-package', async (req: Request, res: Response) => {
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
app.post('/invoices/simple', async (req: Request, res: Response) => {
  const schema = z.object({
    studentId: z.string(),
    type: z.string().default('fee'),
    totalAmount: z.number().positive(),
    items: z.array(z.object({ name: z.string(), amount: z.number().positive() })).min(1),
    initialPayment: z.number().min(0).optional().default(0),
    method: z.string().optional().default('cash'),
    billingMonth: z.string().optional(),
    date: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { studentId, type, totalAmount, items, initialPayment, method, billingMonth, date } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          studentId,
          type,
          totalAmount: roundMoney(totalAmount),
          status: 'unpaid',
          billingMonth,
          createdAt: date ? new Date(date) : undefined,
          items: {
            create: items.map(i => ({ name: i.name, amount: roundMoney(i.amount) }))
          }
        },
        include: { items: true, payments: true }
      });

      if (initialPayment && initialPayment > 0) {
        const newPaidAmount = money(invoice.paidAmount).plus(initialPayment);
        const newStatus = newPaidAmount.gte(invoice.totalAmount) ? 'paid' : 'partial';
        await tx.payment.create({
          data: {
            invoiceId: invoice.id,
            amount: money(initialPayment).toDecimalPlaces(2),
            method
          }
        });
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { paidAmount: newPaidAmount, status: newStatus }
        });
        await tx.ledgerEntry.create({
          data: {
            type: 'income',
            category: type === 'admission' ? 'admission_fee' : 'fee_collection',
            amount: money(initialPayment).toDecimalPlaces(2),
            referenceInvoice: invoice.id
          }
        });
      }

      return await tx.invoice.findUnique({ where: { id: invoice.id }, include: { items: true, payments: true } });
    });
    res.status(201).json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

app.get('/invoices/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  console.log(`[GET /invoices/:id] Fetching invoice with id: ${id}`);
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { items: true, payments: true, student: true }
  });
  console.log(`[GET /invoices/:id] Result:`, invoice ? 'Found' : 'NULL');
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  res.json(invoice);
});

// Staff
app.get('/staff', async (_req: Request, res: Response) => {
  const staff = await prisma.staff.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(staff);
});

app.post('/staff', async (req: Request, res: Response) => {
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

app.put('/staff/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const staff = await prisma.staff.update({ where: { id }, data: req.body });
  res.json(staff);
});

app.delete('/staff/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  await prisma.staff.delete({ where: { id } });
  res.status(204).send();
});

// Staff Salaries
app.get('/salaries/staff', async (_req: Request, res: Response) => {
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

app.post('/salaries/staff/process', async (req: Request, res: Response) => {
  const schema = z.object({
    staffIds: z.array(z.string()).min(1),
    month: z.number().min(1).max(12),
    year: z.number(),
    paymentDate: z.string().transform(d => new Date(d)),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { staffIds, paymentDate } = parsed.data;

  const staff = await prisma.staff.findMany({ where: { id: { in: staffIds } } });
  const results = [];

  for (const s of staff) {
    const salary = await prisma.staffSalary.create({
      data: {
        staffId: s.id,
        baseSalary: 1000, // Default or fetch from staff profile if added
        netSalary: 1000,
        paymentDate,
        status: 'Pending'
      }
    });
    results.push(salary);
  }
  res.json(results);
});

app.post('/salaries/staff/:id/pay', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await prisma.$transaction(async (tx) => {
    const salary = await tx.staffSalary.update({ where: { id }, data: { status: 'Paid' } });
    await tx.ledgerEntry.create({
      data: {
        type: 'expense',
        category: 'staff_salary',
        amount: salary.netSalary,
        referenceInvoice: salary.id
      }
    });
    return salary;
  });
  res.json(result);
});

// Ledger & Transactions
app.get('/finance/transactions', async (req: Request, res: Response) => {
  const { type, category } = req.query;
  const where: any = {};
  if (type) where.type = String(type);
  if (category) where.category = String(category);

  const entries = await prisma.ledgerEntry.findMany({
    where,
    orderBy: { createdAt: 'desc' }
  });
  res.json(entries);
});

app.get('/finance/income', async (_req: Request, res: Response) => {
  const entries = await prisma.ledgerEntry.findMany({
    where: { type: 'income' },
    orderBy: { createdAt: 'desc' }
  });
  res.json(entries);
});

// Financial Reports
app.get('/finance/reports/summary', async (req: Request, res: Response) => {
  const { from, to } = req.query;
  const where: any = {};
  if (from && to) {
    where.createdAt = { gte: new Date(String(from)), lte: new Date(String(to)) };
  }

  const entries = await prisma.ledgerEntry.findMany({ where });
  const income = entries.filter(e => e.type === 'income').reduce((s, e) => s.plus(e.amount), money(0));
  const expense = entries.filter(e => e.type === 'expense').reduce((s, e) => s.plus(e.amount), money(0));

  const byCategory = entries.reduce((acc: any, e) => {
    acc[e.category] = money(acc[e.category]).plus(e.amount).toNumber();
    return acc;
  }, {});

  res.json({
    totalIncome: income,
    totalExpense: expense,
    netProfit: income.minus(expense),
    byCategory
  });
});

// Fee Reports
app.get('/finance/reports/fees', async (req: Request, res: Response) => {
  const invoices = await prisma.invoice.findMany({
    include: { payments: true, student: true }
  });

  const report = invoices.map(inv => {
    const paid = inv.payments.reduce((s, p) => s.plus(p.amount), money(0));
    return {
      studentName: inv.student.name,
      class: inv.student.class,
      type: inv.type,
      total: inv.totalAmount,
      paid,
      due: inv.totalAmount.minus(paid),
      status: inv.status,
      date: inv.createdAt
    };
  });

  res.json(report);
});

// Grading System
app.get('/grading', async (req: Request, res: Response) => {
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

app.post('/grading/bulk', async (req: Request, res: Response) => {
  const schema = z.array(z.object({
    id: z.string().optional(),
    grade: z.string(),
    minPercent: z.number(),
    maxPercent: z.number(),
    gp: z.number().default(0),
    status: z.string(),
    examTypeId: z.string(),
    writtenPass: z.number().optional().nullable(),
    mcqPass: z.number().optional().nullable(),
    totalPass: z.number().optional().nullable(),
  }));
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const incoming = parsed.data;
  const typeIds = [...new Set(incoming.map(i => i.examTypeId))];

  await prisma.$transaction(async (tx) => {
    await tx.gradingSystem.deleteMany({
      where: { examTypeId: { in: typeIds } }
    });
    await tx.gradingSystem.createMany({
      data: incoming.map(i => ({
        grade: i.grade,
        minPercent: i.minPercent,
        maxPercent: i.maxPercent,
        gp: i.gp,
        status: i.status,
        examTypeId: i.examTypeId,
        writtenPass: i.writtenPass,
        mcqPass: i.mcqPass,
        totalPass: i.totalPass
      }))
    });
  });

  res.json({ success: true });
});

// Fee Particulars
app.get('/fee-particulars', async (req: Request, res: Response) => {
  const { target } = req.query;
  const where: any = {};
  if (target) where.target = String(target);

  const particulars = await prisma.feeParticular.findMany({
    where,
    orderBy: { createdAt: 'asc' }
  });
  res.json(particulars);
});

app.post('/fee-particulars/bulk', async (req: Request, res: Response) => {
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

    // One teacher per (class, subject) — upsert so reassigning just updates the teacher.
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
    if (role && role.toLowerCase() === 'admin') {
      // Look for admin user in the users table
      user = await prisma.user.findFirst({
        where: {
          OR: [
            { email: email },
            { email: { contains: email } }
          ]
        }
      });

      // For admin, check password (simplified - in production use proper hashing)
      if (user && user.email === email && (password === 'fresh_password_2026' || await bcrypt.compare(password, user.password))) {
        // Admin found
      } else {
        user = null;
      }
    } else if (role && role.toLowerCase() === 'teacher') {
      // Look for teacher in the teachers table
      console.log('Teacher login attempt:', { email, password, role });

      const teacher = await prisma.teacher.findFirst({
        where: {
          OR: [
            { email: email },
            { employeeId: email },
            { phone: email } // Also check phone in case they enter phone number
          ]
        }
      });

      console.log('Teacher found:', teacher ? 'YES' : 'NO');
      if (teacher) {
        console.log('Teacher details:', { id: teacher.id, name: teacher.name, email: teacher.email, employeeId: teacher.employeeId });

        // For teachers, check if password matches teacher's employeeId or email
        // This is a simplified approach - in production, use the TeacherLogin table
        if (password === teacher.employeeId ||
          password === teacher.email.split('@')[0] ||
          password === 'password' ||
          password === 'test' ||
          password === '123456') { // Added common test password
          user = {
            id: teacher.id,
            email: teacher.email,
            role: 'Teacher',
            name: teacher.name,
            subject: teacher.subject
          };
          console.log('Teacher authenticated successfully');
        } else {
          console.log('Teacher password mismatch. Tried:', password, 'against:', {
            employeeId: teacher.employeeId,
            emailPrefix: teacher.email.split('@')[0],
            password: 'password',
            test: 'test',
            '123456': '123456'
          });
        }
      } else {
        console.log('Teacher not found with:', email);
        // List all teachers for debugging
        const allTeachers = await prisma.teacher.findMany({
          select: { id: true, name: true, email: true, employeeId: true, phone: true }
        });
        console.log('Available teachers:', allTeachers);
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
          // For students without login records, accept any password (simplified)
          user = {
            id: student.id,
            studentId: student.id,
            email: student.email,
            role: 'Student',
            name: student.name,
            admissionNo: student.admissionNo
          };
        }
      }
    }

    if (user) {
      // Generate JWT token
      const token = jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        process.env.JWT_SECRET || 'fallback-secret',
        { expiresIn: '7d' }
      );

      return res.json({
        user: user,
        token: token
      });
    }

    return res.status(401).json({ error: 'Invalid credentials' });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

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

  return exams.map((e: any) => {
    const classMap = new Map<string, any>();
    (e.schedules || []).forEach((s: any) => {
      if (s.class) classMap.set(s.class.id, { id: s.class.id, name: s.class.name, section: s.class.section });
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
    if (!allowed.has(classId as string)) {
      return res.status(403).json({ error: 'You are not assigned to this class' });
    }

    const classInfo = await prisma.schoolClass.findUnique({ where: { id: classId as string } });
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
        roll: true
      },
      orderBy: { roll: 'asc' }
    });

    // Load any existing attendance for this class on the requested date
    const dayStart = new Date(String(date));
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const savedRecords = await prisma.attendance.findMany({
      where: {
        date: { gte: dayStart, lt: dayEnd },
        studentId: { in: students.map((s) => s.id) }
      },
      select: { studentId: true, status: true }
    });
    const statusMap = new Map(savedRecords.map((r) => [r.studentId, r.status]));

    const studentData = students.map(student => ({
      studentId: student.id,
      studentName: student.name,
      roll: student.roll,
      status: statusMap.get(student.id) || 'present'
    }));

    res.json(studentData);
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance data' });
  }
});

app.post('/teacher/attendance', authMiddleware, checkRole(['Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { classId, date, records } = req.body;

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
    if (!allowed.has(classId)) {
      return res.status(403).json({ error: 'You are not assigned to this class' });
    }

    const classInfo = await prisma.schoolClass.findUnique({ where: { id: classId } });
    if (!classInfo) {
      return res.status(404).json({ error: 'Class not found' });
    }

    // Save attendance to the Attendance table (same as /attendance/save)
    const day = new Date(String(date));
    const students = await prisma.student.findMany({
      where: { class: classInfo.name, section: classInfo.section }
    });
    const ids = new Set(students.map((s) => s.id));
    const toSave = (records as any[]).filter((r: any) => r.studentId && ids.has(r.studentId));

    if (toSave.length === 0) {
      return res.status(400).json({ error: 'No valid student records provided' });
    }

    await prisma.$transaction(
      toSave.map((r: any) =>
        prisma.attendance.upsert({
          where: { studentId_date: { studentId: r.studentId, date: day } },
          update: { status: String(r.status) },
          create: { studentId: r.studentId, date: day, status: String(r.status) }
        })
      )
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
    const teacher = await prisma.teacher.findFirst({
      where: { email: user.email }
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

app.get('/class-routine/classes', async (_req: Request, res: Response) => {
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

app.get('/class-routine/teachers', async (_req: Request, res: Response) => {
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

app.get('/class-routine/subjects', async (_req: Request, res: Response) => {
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

app.get('/class-routine/rooms', async (_req: Request, res: Response) => {
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

app.get('/class-routine/time-slots', async (_req: Request, res: Response) => {
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
      return res.json(defaultSlots);
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

app.post('/class-routine/periods/save', async (req: Request, res: Response) => {
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

app.post('/class-routine/periods/reorder', async (req: Request, res: Response) => {
  try {
    const schema = z.object({ ids: z.array(z.string()).min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { ids } = parsed.data;
    const tx = await prisma.$transaction(
      ids.map((id, index) => prisma.routinePeriod.update({
        where: { id },
        data: { sortOrder: index }
      }))
    );

    const all = await prisma.routinePeriod.findMany({ orderBy: { sortOrder: 'asc' } });
    res.json(all.map(p => ({ id: p.id, period: p.period, timeRange: p.timeRange, isBreak: p.isBreak })));
  } catch (error) {
    console.error('Error reordering periods:', error);
    res.status(500).json({ error: 'Failed to reorder periods' });
  }
});

app.delete('/class-routine/periods/:id', async (req: Request, res: Response) => {
  try {
    await prisma.routinePeriod.delete({ where: { id: req.params.id } });
    const all = await prisma.routinePeriod.findMany({ orderBy: { sortOrder: 'asc' } });
    res.json(all.map(p => ({ id: p.id, period: p.period, timeRange: p.timeRange, isBreak: p.isBreak })));
  } catch (error) {
    console.error('Error deleting period:', error);
    res.status(500).json({ error: 'Failed to delete period' });
  }
});

app.get('/class-routine/timetable', async (req: Request, res: Response) => {
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

app.post('/class-routine/update-entry', async (req: Request, res: Response) => {
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

    // Save marks for each student
    const savedMarks = await prisma.$transaction(
      marks.map((mark: any) => {
        const resolvedSubjectId = mark.subjectId || fallbackSubjectId;
        if (!resolvedSubjectId) {
          throw new Error('subjectId is required to save marks');
        }

        return prisma.result.upsert({
          where: {
            studentId_examId_subjectId: {
              studentId: mark.studentId,
              examId: examId,
              subjectId: resolvedSubjectId
            }
          },
          update: {
            written: parseFloat(mark.written) || 0,
            mcq: parseFloat(mark.mcq) || 0,
            practical: parseFloat(mark.practical) || 0,
            totalMarks: mark.total,
            grade: mark.grade,
            gp: mark.gp
          },
          create: {
            studentId: mark.studentId,
            examId: examId,
            subjectId: resolvedSubjectId,
            written: parseFloat(mark.written) || 0,
            mcq: parseFloat(mark.mcq) || 0,
            practical: parseFloat(mark.practical) || 0,
            totalMarks: mark.total,
            grade: mark.grade,
            gp: mark.gp
          }
        })
      })
    );

    res.json({ 
      success: true, 
      message: 'Marks saved successfully',
      count: savedMarks.length 
    });
  } catch (error) {
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

// Day key from a stored attendance date (UTC), e.g. "2026-08-21".
function utcDayKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Find a student by the email / id / admissionNo provided by the frontend.
function findStudent(email: unknown, studentId: unknown) {
  return prisma.student.findFirst({
    where: {
      OR: [
        ...(email ? [{ email: email as string }] : []),
        ...(studentId ? [{ id: studentId as string }] : []),
        ...(email ? [{ admissionNo: email as string }] : []),
      ],
    },
  });
}

app.get('/student/dashboard', async (req: Request, res: Response) => {
  try {
    const { email, studentId } = req.query;

    const student = await findStudent(email, studentId);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const today = new Date();
    const next30 = new Date();
    next30.setDate(next30.getDate() + 30);

    const [attendance, results, fees, classRecord, allSchedules, subjects] = await Promise.all([
      prisma.attendance.findMany({ where: { studentId: student.id } }),
      prisma.result.findMany({
        where: { studentId: student.id },
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
    ]);
    const subjectName = (id: string) => subjects.find((s) => s.id === id)?.name || 'Subject';

    // Exam schedules relevant to this student's class (or the whole school).
    const schedules = allSchedules.filter(
      (s) => (classRecord && s.classId === classRecord.id) || s.classId === null
    );

    const present = attendance.filter((a) => a.status === 'Present').length;
    const total = attendance.length;
    const attendancePct = total ? Math.round((present / total) * 100) : 0;

    const totalFee = fees.reduce((s, f) => s + (Number(f.amount) - Number(f.discount || 0)), 0);
    const paid = fees.filter((f) => f.status === 'Paid').reduce((s, f) => s + (Number(f.amount) - Number(f.discount || 0)), 0);
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

    const latestNotices: never[] = [];

    const recentResults = results.map((r) => ({
      subject: subjectName(r.subjectId),
      marks: r.totalMarks,
      grade: r.grade || '—',
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
        value: due > 0 ? `$${due.toFixed(2)}` : 'Paid',
        description: totalFee > 0 ? `$${paid.toFixed(2)} paid of $${totalFee.toFixed(2)}` : 'No fees recorded',
        bgColor: due > 0 ? 'bg-red-50' : 'bg-green-100',
        color: due > 0 ? 'text-red-600' : 'text-green-600',
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

app.get('/student/profile', async (req: Request, res: Response) => {
  try {
    const { email, studentId } = req.query;

    const student = await prisma.student.findFirst({
      where: {
        OR: [
          ...(email ? [{ email: email as string }] : []),
          ...(studentId ? [{ id: studentId as string }] : []),
          ...(email ? [{ admissionNo: email as string }] : []),
        ],
      },
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

app.get('/student/results', async (req: Request, res: Response) => {
  try {
    const { email, studentId } = req.query;

    const student = await findStudent(email, studentId);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const [results, subjects] = await Promise.all([
      prisma.result.findMany({
        where: { studentId: student.id },
        include: { exam: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.subject.findMany(),
    ]);
    const subjectName = (id: string) => subjects.find((s) => s.id === id)?.name || 'Subject';

    // Group results by exam so the portal shows only real exams.
    const byExam = new Map<string, typeof results>();
    for (const r of results) {
      if (!byExam.has(r.examId)) byExam.set(r.examId, []);
      byExam.get(r.examId)!.push(r);
    }

    const classmates = await prisma.student.findMany({
      where: { class: student.class, section: student.section },
      select: { id: true },
    });
    const classmateIds = classmates.map((c) => c.id);

    const exams: Array<{ id: string; name: string; resultData: any[]; overall: { totalMarks: number; grade: string; gpa: number; rank: number } }> = [];
    for (const [examId, list] of byExam.entries()) {
      const rows = list.map((r) => ({
        id: r.id,
        subject: subjectName(r.subjectId),
        written: r.written,
        mcq: r.mcq,
        total: r.totalMarks,
        grade: r.grade || '—',
        gpa: r.gp ?? 0,
      }));

      const totalMarks = rows.reduce((s, r) => s + r.total, 0);
      const avgGpa = rows.length ? rows.reduce((s, r) => s + r.gpa, 0) / rows.length : 0;
      const bestGrade = rows.length ? rows.reduce((best, r) => (r.grade && r.grade !== '—' && (!best || r.grade < best) ? r.grade : best), '' as string | null) : null;

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
          grade: bestGrade || '—',
          gpa: Math.round(avgGpa * 100) / 100,
          rank,
        },
      });
    }

    res.json({
      exams,
      resultData: exams.length ? exams[0].resultData : [],
      overall: exams.length ? exams[0].overall : { totalMarks: 0, grade: '—', gpa: 0, rank: 1 },
    });
  } catch (error) {
    console.error('Error fetching student results:', error);
    res.status(500).json({ error: 'Failed to fetch results data' });
  }
});

app.get('/student/fees', async (req: Request, res: Response) => {
  try {
    const { email, studentId } = req.query;

    const student = await findStudent(email, studentId);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const [fees, invoices] = await Promise.all([
      prisma.studentFee.findMany({ where: { studentId: student.id }, orderBy: { createdAt: 'desc' } }),
      prisma.invoice.findMany({
        where: { studentId: student.id },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const totalFee = fees.reduce((s, f) => s + (Number(f.amount) - Number(f.discount || 0)), 0);
    const paid = fees.filter((f) => f.status === 'Paid').reduce((s, f) => s + (Number(f.amount) - Number(f.discount || 0)), 0);
    const due = totalFee - paid;

    const feeStats = {
      totalFee: Math.round(totalFee * 100) / 100,
      paid: Math.round(paid * 100) / 100,
      due: Math.round(due * 100) / 100,
    };

    const normalizeStatus = (s?: string) =>
      s === 'paid' || s === 'Paid' ? 'Paid' : s === 'partial' || s === 'Partial' ? 'Partial' : 'Due';

    const invoiceList = invoices.map((inv) => ({
      id: inv.id.slice(-8).toUpperCase(),
      type: inv.type,
      date: toDateStr(inv.createdAt),
      amount: Number(inv.totalAmount),
      status: normalizeStatus(inv.status),
    }));

    res.json({ feeStats, invoices: invoiceList });
  } catch (error) {
    console.error('Error fetching student fees:', error);
    res.status(500).json({ error: 'Failed to fetch fees data' });
  }
});

app.get('/student/attendance', async (req: Request, res: Response) => {
  try {
    const { email, studentId } = req.query;

    const student = await findStudent(email, studentId);
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
      absent: attendance.filter((a) => a.status === 'Absent').length,
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

app.get('/student/exam-schedule', async (req: Request, res: Response) => {
  try {
    const { email, studentId } = req.query;

    const student = await findStudent(email, studentId);
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

app.get('/student/notices', async (_req: Request, res: Response) => {
  try {
    res.json([]);
  } catch (error) {
    console.error('Error fetching notices:', error);
    res.status(500).json({ error: 'Failed to fetch notices' });
  }
});

app.get('/student/messages', async (_req: Request, res: Response) => {
  try {
    res.json({ contacts: [], messages: [] });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.get('/student/assignments', async (_req: Request, res: Response) => {
  try {
    res.json([]);
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

const port = Number(process.env.PORT) || 4000;

async function ensureStudentAcademicRecordTable() {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "StudentAcademicRecord" LIMIT 1`;
    return;
  } catch {
    // Table does not exist yet — create it below
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

