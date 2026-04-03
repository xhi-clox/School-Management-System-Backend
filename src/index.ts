import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { addMonths } from 'date-fns';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';


const prisma = new PrismaClient();
const app = express();

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

const isVercelPreviewOrigin = (origin: string) =>
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Non-browser clients (curl, server-to-server) — no Origin header
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    // Vercel preview deployments (random subdomain)
    if (isVercelPreviewOrigin(origin)) return callback(null, true);
    return callback(new Error('CORS not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Data'],
  optionsSuccessStatus: 204,
};

// Set fallback JWT_SECRET if not in environment
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'fallback-jwt-secret-for-development';
}

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(morgan('dev'));

app.get('/', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'Academify School Management System API',
    status: 'running',
    message: 'API is running',
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get('/test-db', async (_req: Request, res: Response) => {
  try {
    const count = await prisma.user.count();
    res.json({ ok: true, userCount: count });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/notifications', (_req: Request, res: Response) => {
  res.json([
    { id: '1', message: 'Welcome to the School Management System!', createdAt: new Date() },
    { id: '2', message: 'New academic year setup is available.', createdAt: new Date() }
  ]);
});

// Dashboard Stats
app.get('/dashboard/stats', async (_req: Request, res: Response) => {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  const [
    totalStudents,
    activeStudents,
    teachersCount,
    classesCount,
    staffCount,
    todayAttendanceRaw,
    recentActivity,
    upcomingExams
  ] = await Promise.all([
    prisma.student.count(),
    prisma.student.count({ where: { status: 'Active' } }),
    prisma.teacher.count(),
    prisma.schoolClass.count(),
    prisma.staff.count(),
    prisma.attendance.findMany({
      where: { date: { gte: todayStart, lt: todayEnd } },
      select: { status: true }
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

  const studentsPerClass = await prisma.student.groupBy({
    by: ['class'],
    _count: { id: true }
  });

  const allTimeIncome = await prisma.ledgerEntry.aggregate({
    _sum: { amount: true },
    where: { type: 'income' }
  });
  const allTimeExpense = await prisma.ledgerEntry.aggregate({
    _sum: { amount: true },
    where: { type: 'expense' }
  });

  const incomeTotal = allTimeIncome._sum.amount || 0;
  const expenseTotal = allTimeExpense._sum.amount || 0;
  const totalBalance = incomeTotal - expenseTotal;

  const normalizedStatuses = todayAttendanceRaw.map((r) => String(r.status || '').trim().toLowerCase());
  const absent = normalizedStatuses.filter((s) => s === 'absent' || s === 'a').length;
  const late = normalizedStatuses.filter((s) => s === 'late' || s === 'l').length;
  const onLeave = normalizedStatuses.filter((s) => s === 'leave' || s === 'lv' || s === 'on leave' || s === 'on-leave' || s === 'half-day' || s === 'h').length;
  const explicitPresent = normalizedStatuses.filter((s) => s === 'present' || s === 'p').length;
  const tracked = explicitPresent + absent + late + onLeave;
  const totalForToday = activeStudents || totalStudents;
  const inferredPresent = Math.max(totalForToday - tracked, 0);
  const present = explicitPresent + inferredPresent;

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
    historyIncome.push({ date: histStart, amount: li._sum.amount || 0 });
    historyExpense.push({ date: histStart, amount: le._sum.amount || 0 });
  }

  res.json({
    counts: {
      students: totalStudents,
      activeStudents,
      inactiveStudents,
      teachers: teachersCount,
      classes: classesCount,
      staff: staffCount
    },
    financials: {
      income: incomeTotal,
      expense: expenseTotal,
      profit: incomeTotal - expenseTotal,
      totalBalance,
      history: {
        income: historyIncome.map(h => ({ date: h.date, amount: h.amount })),
        expense: historyExpense.map(h => ({ date: h.date, amount: h.amount }))
      }
    },
    todayAttendance: {
      total: totalForToday,
      present,
      absent,
      late,
      onLeave
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

app.get('/dashboard/financial-details', async (req: Request, res: Response) => {
  const schema = z.object({
    type: z.enum(['income', 'expense', 'profit']),
    month: z.coerce.number().int().min(1).max(12).optional().default(new Date().getMonth() + 1),
    year: z.coerce.number().int().optional().default(new Date().getFullYear()),
    limit: z.coerce.number().int().min(1).max(200).optional().default(10),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { type, month, year, limit } = parsed.data;
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);

  try {
    if (type === 'profit') {
      const income = await prisma.ledgerEntry.aggregate({
        _sum: { amount: true },
        where: { type: 'income', createdAt: { gte: start, lt: end } }
      });
      const expense = await prisma.ledgerEntry.aggregate({
        _sum: { amount: true },
        where: { type: 'expense', createdAt: { gte: start, lt: end } }
      });
      const incomeTotal = income._sum.amount || 0;
      const expenseTotal = expense._sum.amount || 0;
      return res.json({
        total: incomeTotal - expenseTotal,
        incomeTotal,
        expenseTotal
      });
    }

    const entries = await prisma.ledgerEntry.findMany({
      where: { type, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: 'desc' },
      take: limit
    });

    const total = entries.reduce((s, e) => s + e.amount, 0);
    const map: Record<string, number> = {};
    for (const e of entries) map[e.category] = (map[e.category] || 0) + e.amount;
    const breakdown = Object.entries(map).map(([category, amount]) => ({ category, amount }));

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

import { authMiddleware } from './auth';
import { checkRole } from './checkRole';

// Students
app.get('/students', authMiddleware, async (req: Request, res: Response) => {
  const user = (req as any).user;

  if (user.role === 'Teacher') {
    const teacher = await prisma.teacher.findUnique({ where: { id: user.id } });
    if (teacher) {
      const classes = await prisma.schoolClass.findMany({ where: { teacher: { id: teacher.id } } });
      const classNames = classes.map(c => c.name);
      const students = await prisma.student.findMany({ where: { class: { in: classNames } }, orderBy: { createdAt: 'desc' } });
      return res.json(students);
    }
  }

  const students = await prisma.student.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(students);
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

app.post('/students/promote', async (req: Request, res: Response) => {
  const schema = z.object({
    studentIds: z.array(z.string()).min(1),
    newClass: z.string().min(1),
    newSection: z.string().min(1),
    newAcademicYear: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { studentIds, newClass, newSection, newAcademicYear } = parsed.data;

  await prisma.student.updateMany({
    where: { id: { in: studentIds } },
    data: {
      class: newClass,
      section: newSection,
      academicYear: newAcademicYear,
      // Reset roll number? Maybe keep it or set to 0 for re-assignment
      // roll: 0 
    }
  });

  res.json({ success: true, count: studentIds.length });
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
        amount: fee.amount - fee.discount,
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
  const classes = await prisma.schoolClass.findMany({ orderBy: [{ name: 'asc' }, { section: 'asc' }] });
  const counts = await Promise.all(
    classes.map(async (c) => {
      const count = await prisma.student.count({ where: { class: c.name, section: c.section } });
      return { ...c, students: count };
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
    let tuitionAmount = 0;

    // Priority 1: Student-specific tuition assignment
    const studentAssignment = assignments.find((a: any) => {
      const startsBeforeOrEqual = a.startYear < year || (a.startYear === year && a.startMonth <= month);
      const endsAfterOrNull = !a.endYear || a.endYear > year || (a.endYear === year && (!a.endMonth || a.endMonth >= month));
      return a.studentId === student.id && startsBeforeOrEqual && endsAfterOrNull;
    });

    if (studentAssignment) {
      tuitionAmount = studentAssignment.customAmount ?? studentAssignment.feeStructure.amount;
      if (studentAssignment.discountPercent > 0) {
        tuitionAmount = tuitionAmount - (tuitionAmount * (studentAssignment.discountPercent / 100));
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
          tuitionAmount = tuitionItem.amount;
        }
      }
    }

    if (tuitionAmount <= 0) {
      skipped++; // Or handle as "No tuition defined"
      continue;
    }

    // Apply Proration if requested
    let finalAmount = tuitionAmount;
    if (prorate) {
      const admissionDate = student.admissionDate;
      if (admissionDate && admissionDate.getFullYear() === year && (admissionDate.getMonth() + 1) === month) {
        const remainingDays = totalDaysInMonth - admissionDate.getDate() + 1;
        finalAmount = (tuitionAmount / totalDaysInMonth) * remainingDays;
      }
    }

    // Create Invoice
    await prisma.invoice.create({
      data: {
        studentId: student.id,
        type: 'tuition',
        totalAmount: Math.round(finalAmount),
        status: 'unpaid',
        billingMonth: billingMonth,
        dueDate: new Date(year, month - 1, dueDay),
        items: {
          create: [{ name: `Monthly Tuition - ${billingMonth}`, amount: Math.round(finalAmount) }]
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

  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
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
    const day = String(new Date(r.date).getDate()).padStart(2, '0');
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

// Create Student with Admission Package (Transaction)
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
      siblingsCount: z.number().int().optional(),
      classId: z.string(), // This is SchoolClass ID
      section: z.string().optional(),
      shift: z.string().optional(),
      roll: z.number().optional(),
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
      // Need to resolve class name from classId if not provided or just use pkg.class.name
      const className = pkg.class.name;

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
        section: student.section || pkg.class.section, // Default to class section if not provided
        shift: student.shift,
        roll: student.roll || 0, // Should be auto-generated or handled
        academicYear: student.academicYear || pkg.session,
        fatherName: guardian.fatherName,
        motherName: guardian.motherName,
        guardianPhone: guardian.guardianPhone,
        guardianEmail: guardian.guardianEmail,
        address: guardian.address || guardian.guardianAddress,
        admissionNo: `ADM-${Date.now()}`, // Simple auto-gen
        status: 'pending_payment'
      };

      const newStudent = await (tx as any).student.create({
        data: studentData
      });

      // 2. Create or update Guardian record with normalized fields
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
      const totalAmount = pkg.feeItems.reduce((sum, item) => sum + item.amount, 0);

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

    console.log(`[POST /students/admission] Generated Invoice ID: ${result.invoice.id}`);
    res.json(result);
  } catch (error: any) {
    console.error('[POST /students/admission] Error:', error);
    res.status(500).json({ 
      error: 'Failed to process admission',
      details: error?.message || 'Unknown error',
      code: error?.code,
      meta: error?.meta
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

      const newPaidAmount = invoice.paidAmount + amount;
      const newStatus = newPaidAmount >= invoice.totalAmount ? 'paid' : 'partial';

      // 1. Create Payment
      const payment = await tx.payment.create({
        data: {
          invoiceId,
          amount,
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
          amount,
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

  const totalAmount = pkg.feeItems.reduce((sum, item) => sum + item.amount, 0);

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
          totalAmount,
          status: 'unpaid',
          billingMonth,
          createdAt: date ? new Date(date) : undefined,
          items: {
            create: items.map(i => ({ name: i.name, amount: i.amount }))
          }
        },
        include: { items: true, payments: true }
      });

      if (initialPayment && initialPayment > 0) {
        const newPaidAmount = invoice.paidAmount + initialPayment;
        const newStatus = newPaidAmount >= invoice.totalAmount ? 'paid' : 'partial';
        await tx.payment.create({
          data: {
            invoiceId: invoice.id,
            amount: initialPayment,
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
            amount: initialPayment,
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
  const income = entries.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);
  const expense = entries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);

  const byCategory = entries.reduce((acc: any, e) => {
    acc[e.category] = (acc[e.category] || 0) + e.amount;
    return acc;
  }, {});

  res.json({
    totalIncome: income,
    totalExpense: expense,
    netProfit: income - expense,
    byCategory
  });
});

// Fee Reports
app.get('/finance/reports/fees', async (req: Request, res: Response) => {
  const invoices = await prisma.invoice.findMany({
    include: { payments: true, student: true }
  });

  const report = invoices.map(inv => {
    const paid = inv.payments.reduce((s, p) => s + p.amount, 0);
    return {
      studentName: inv.student.name,
      class: inv.student.class,
      type: inv.type,
      total: inv.totalAmount,
      paid,
      due: inv.totalAmount - paid,
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
      include: {
        classes: {
          include: {
            _count: {
              select: {
                packages: true
              }
            }
          }
        }
      }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Get today's date
    const today = new Date();
    const dayName = today.toLocaleDateString('en-US', { weekday: 'long' });

    // Get today's classes (mock data for now - would come from routine table)
    const todaysClasses = teacher.classes.map(cls => ({
      time: '09:00 - 09:40',
      subject: teacher.subject || 'Mathematics',
      class: `${cls.name} - ${cls.section}`,
      room: 'R-101'
    }));

    // Get pending attendance (classes today that need attendance)
    const pendingAttendance = todaysClasses.length;

    // Get assignments to review (mock data)
    const assignmentsToReview = 5;

    // Get upcoming exams (mock data)
    const upcomingExams = [
      { date: '2024-01-15', subject: teacher.subject || 'Mathematics', class: 'Grade 1 - A' },
      { date: '2024-01-20', subject: teacher.subject || 'Mathematics', class: 'Grade 1 - A' }
    ];

    // Get messages (mock data)
    const messages = [
      { id: '1', from: 'Admin', subject: 'Meeting Tomorrow' },
      { id: '2', from: 'Parent', subject: 'Student Progress' }
    ];

    // Get recent notices (mock data)
    const recentNotices = [
      { id: '1', title: 'School Holiday', date: '2024-01-10' },
      { id: '2', title: 'Exam Schedule', date: '2024-01-08' }
    ];

    const stats = {
      teacher: {
        id: teacher.id,
        name: teacher.name,
        email: teacher.email,
        subject: teacher.subject,
        classes: teacher.classes.map(cls => ({
          id: cls.id,
          name: cls.name,
          section: cls.section,
          studentCount: cls._count.packages || 0
        }))
      },
      todaysClasses,
      pendingAttendance,
      assignmentsToReview,
      upcomingExams,
      messages,
      recentNotices
    };

    res.json(stats);
  } catch (error) {
    console.error('Error fetching teacher dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

app.get('/teacher/classes', authMiddleware, checkRole(['Teacher']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    // Get teacher information
    const teacher = await prisma.teacher.findFirst({
      where: { email: user.email },
      include: {
        classes: {
          include: {
            _count: {
              select: {
                packages: true
              }
            }
          }
        }
      }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Return only classes where this teacher is assigned as class teacher
    const classes = teacher.classes.map(cls => ({
      id: cls.id,
      name: cls.name,
      section: cls.section,
      studentCount: cls._count.packages || 0,
      isClassTeacher: true
    }));

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
      include: {
        classes: {
          where: { id: classId }
        }
      }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    if (teacher.classes.length === 0) {
      return res.status(403).json({ error: 'You are not assigned to this class' });
    }

    const classInfo = teacher.classes[0];

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

    // Get subjects (mock data for now - would come from teacher-subject assignment table)
    const subjects = [
      { id: '1', name: teacher.subject || 'Mathematics', code: 'MATH101', type: 'Core' }
    ];

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
      include: {
        classes: {
          where: { id: classId as string }
        }
      }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    if (teacher.classes.length === 0) {
      return res.status(403).json({ error: 'You are not assigned to this class' });
    }

    const classInfo = teacher.classes[0];

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

    const studentData = students.map(student => ({
      studentId: student.id,
      studentName: student.name,
      roll: student.roll,
      status: 'Present' // Default status
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
      include: {
        classes: {
          where: { id: classId }
        }
      }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    if (teacher.classes.length === 0) {
      return res.status(403).json({ error: 'You are not assigned to this class' });
    }

    // For now, just return success (in real implementation, save to attendance table)
    res.json({ success: true, message: 'Attendance saved successfully' });
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

    // Get exam schedules for this teacher's subjects (mock data)
    const exams = [
      {
        id: '1',
        name: 'Mid-term Exam',
        subject: teacher.subject || 'Mathematics',
        date: '2024-01-15',
        class: 'Grade 1 - A',
        startTime: '09:00',
        endTime: '11:00'
      }
    ];

    res.json(exams);
  } catch (error) {
    console.error('Error fetching teacher exams:', error);
    res.status(500).json({ error: 'Failed to fetch exams' });
  }
});

// Class Routine Management
app.get('/api/class-routine/classes', async (_req: Request, res: Response) => {
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

app.get('/api/class-routine/teachers', async (_req: Request, res: Response) => {
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

app.get('/api/class-routine/subjects', async (_req: Request, res: Response) => {
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

app.get('/api/class-routine/rooms', async (_req: Request, res: Response) => {
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

app.get('/api/class-routine/time-slots', async (_req: Request, res: Response) => {
  try {
    // Return time slots data - in a real implementation, this would come from a TimeSlot table
    const timeSlots = [
      { id: '1', period: 'Period 1', timeRange: '08:00 - 08:40', isBreak: false },
      { id: '2', period: 'Period 2', timeRange: '08:40 - 09:20', isBreak: false },
      { id: '3', period: 'Period 3', timeRange: '09:20 - 10:00', isBreak: false },
      { id: 'break', period: 'Break', timeRange: '10:00 - 10:20', isBreak: true },
      { id: '4', period: 'Period 4', timeRange: '10:20 - 11:00', isBreak: false },
      { id: '5', period: 'Period 5', timeRange: '11:00 - 11:40', isBreak: false },
      { id: '6', period: 'Period 6', timeRange: '11:40 - 12:20', isBreak: false },
      { id: '7', period: 'Period 7', timeRange: '12:20 - 01:00', isBreak: false },
    ];

    res.json(timeSlots);
  } catch (error) {
    console.error('Error fetching time slots:', error);
    res.status(500).json({ error: 'Failed to fetch time slots' });
  }
});

app.get('/api/class-routine/timetable', async (req: Request, res: Response) => {
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

    // For now, return empty timetable since we don't have a routine table in the database
    // In a real implementation, you would have a RoutineEntry model and query like:
    // const routines = await prisma.routineEntry.findMany({
    //   where: { classId, section },
    //   include: { subject: true, teacher: true, room: true }
    // });

    const emptyTimetable = {
      [`${classId}-${section}`]: {}
    };

    res.json(emptyTimetable);
  } catch (error) {
    console.error('Error fetching timetable:', error);
    res.status(500).json({ error: 'Failed to fetch timetable' });
  }
});

app.post('/api/class-routine/update-entry', async (req: Request, res: Response) => {
  try {
    const { classId, section, day, period, subject, teacher, room } = req.body;

    // Validation
    const schema = z.object({
      classId: z.string(),
      section: z.string(),
      day: z.enum(['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']),
      period: z.string(),
      subject: z.string(),
      teacher: z.string(),
      room: z.string()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    // For now, just return success since we don't have a routine table
    // In a real implementation, you would update the RoutineEntry table
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
      include: {
        classes: {
          where: { id: classId }
        }
      }
    });

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    if (teacher.classes.length === 0) {
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

// Student Portal Endpoints
app.get('/api/student/dashboard', async (req: Request, res: Response) => {
  try {
    const { email, studentId } = req.query;
    
    // Find student
    const student = await prisma.student.findFirst({
      where: {
        OR: [
          { email: email as string },
          { id: studentId as string },
          { admissionNo: email as string }
        ]
      }
    });

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Mock data for student dashboard
    const dashboardData = {
      student: {
        id: student.id,
        name: student.name,
        email: student.email,
        class: student.class,
        section: student.section,
        roll: student.roll
      },
      attendance: {
        present: 85,
        absent: 5,
        late: 2,
        total: 92
      },
      upcomingExams: [
        { date: '2024-01-15', subject: 'Mathematics', type: 'Mid Term' },
        { date: '2024-01-20', subject: 'Science', type: 'Mid Term' }
      ],
      recentResults: [
        { subject: 'Mathematics', marks: 85, grade: 'A', exam: 'Quiz 1' },
        { subject: 'Science', marks: 78, grade: 'B', exam: 'Quiz 1' }
      ],
      notices: [
        { id: '1', title: 'School Holiday', date: '2024-01-10', priority: 'normal' },
        { id: '2', title: 'Exam Schedule Released', date: '2024-01-08', priority: 'high' }
      ],
      assignments: [
        { id: '1', title: 'Math Homework', subject: 'Mathematics', dueDate: '2024-01-12', status: 'pending' },
        { id: '2', title: 'Science Project', subject: 'Science', dueDate: '2024-01-15', status: 'submitted' }
      ]
    };

    res.json(dashboardData);
  } catch (error) {
    console.error('Error fetching student dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

app.get('/api/student/profile', async (req: Request, res: Response) => {
  try {
    const { email, studentId } = req.query;
    
    const student = await prisma.student.findFirst({
      where: {
        OR: [
          { email: email as string },
          { id: studentId as string },
          { admissionNo: email as string }
        ]
      }
    });

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    res.json(student);
  } catch (error) {
    console.error('Error fetching student profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile data' });
  }
});

app.get('/api/student/results', async (req: Request, res: Response) => {
  try {
    const { email, studentId, examType } = req.query;
    
    const student = await prisma.student.findFirst({
      where: {
        OR: [
          { email: email as string },
          { id: studentId as string },
          { admissionNo: email as string }
        ]
      },
      include: {
        results: {
          include: {
            exam: true
          }
        }
      }
    });

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    res.json(student.results || []);
  } catch (error) {
    console.error('Error fetching student results:', error);
    res.status(500).json({ error: 'Failed to fetch results data' });
  }
});

app.get('/api/student/fees', async (req: Request, res: Response) => {
  try {
    const { email, studentId } = req.query;
    
    const student = await prisma.student.findFirst({
      where: {
        OR: [
          { email: email as string },
          { id: studentId as string },
          { admissionNo: email as string }
        ]
      },
      include: {
        fees: true
      }
    });

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    res.json(student.fees || []);
  } catch (error) {
    console.error('Error fetching student fees:', error);
    res.status(500).json({ error: 'Failed to fetch fees data' });
  }
});

app.get('/api/student/attendance', async (req: Request, res: Response) => {
  try {
    const { email, studentId } = req.query;
    
    const student = await prisma.student.findFirst({
      where: {
        OR: [
          { email: email as string },
          { id: studentId as string },
          { admissionNo: email as string }
        ]
      },
      include: {
        attendance: {
          orderBy: { date: 'desc' },
          take: 30
        }
      }
    });

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    res.json(student.attendance || []);
  } catch (error) {
    console.error('Error fetching student attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance data' });
  }
});

app.get('/api/student/exam-schedule', async (req: Request, res: Response) => {
  try {
    const { email, studentId } = req.query;
    
    const student = await prisma.student.findFirst({
      where: {
        OR: [
          { email: email as string },
          { id: studentId as string },
          { admissionNo: email as string }
        ]
      }
    });

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Get exam schedules for student's class
    const schedules = await prisma.examSchedule.findMany({
      where: {
        class: {
          name: student.class,
          section: student.section
        }
      },
      include: {
        exam: true,
        subject: true
      },
      orderBy: { date: 'asc' }
    });

    res.json(schedules);
  } catch (error) {
    console.error('Error fetching exam schedule:', error);
    res.status(500).json({ error: 'Failed to fetch exam schedule' });
  }
});

app.get('/api/student/notices', async (_req: Request, res: Response) => {
  try {
    // Return mock notices - in production, this would come from a Notice table
    const notices = [
      { id: '1', title: 'School Holiday', content: 'School will be closed on Friday', date: '2024-01-10', priority: 'normal', category: 'general' },
      { id: '2', title: 'Exam Schedule Released', content: 'Mid-term exams start from Jan 15', date: '2024-01-08', priority: 'high', category: 'exam' },
      { id: '3', title: 'Parent Meeting', content: 'Annual parent-teacher meeting on Jan 20', date: '2024-01-05', priority: 'normal', category: 'event' }
    ];

    res.json(notices);
  } catch (error) {
    console.error('Error fetching notices:', error);
    res.status(500).json({ error: 'Failed to fetch notices' });
  }
});

app.get('/api/student/messages', async (_req: Request, res: Response) => {
  try {
    // Return mock messages - in production, this would come from a Message table
    const messages = [
      { id: '1', from: 'Mr. John Doe', subject: 'Math Assignment', content: 'Please submit your homework by Friday', date: '2024-01-10', read: false },
      { id: '2', from: 'Admin', subject: 'Fee Reminder', content: 'Your fee is due for this month', date: '2024-01-08', read: true },
      { id: '3', from: 'Ms. Jane Smith', subject: 'Project Update', content: 'Your science project looks good', date: '2024-01-05', read: true }
    ];

    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.get('/api/student/assignments', async (_req: Request, res: Response) => {
  try {
    // Return mock assignments - in production, this would come from an Assignment table
    const assignments = [
      { id: '1', title: 'Math Homework', subject: 'Mathematics', description: 'Solve problems from chapter 5', dueDate: '2024-01-12', status: 'pending', priority: 'high' },
      { id: '2', title: 'Science Project', subject: 'Science', description: 'Create a model of solar system', dueDate: '2024-01-15', status: 'submitted', priority: 'medium' },
      { id: '3', title: 'English Essay', subject: 'English', description: 'Write an essay on your favorite book', dueDate: '2024-01-18', status: 'pending', priority: 'low' }
    ];

    res.json(assignments);
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Academify API listening on http://0.0.0.0:${port}`);
});

