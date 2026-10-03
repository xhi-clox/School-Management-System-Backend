import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware } from '../auth';
import { checkRole } from '../checkRole';
import { money } from './shared';
import { buildGenerationPreview, runGeneration } from './generation';
import {
  createFeeRecord,
  updateFeeRecord,
  deleteFeeRecord,
  FeeError,
  assertBillingPeriod,
} from './records';

const router = Router();
const prisma = new PrismaClient();

const billingPeriodSchema = z
  .string()
  .refine((v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v), {
    message: 'billingPeriod must be YYYY-MM (e.g. 2026-10)',
  });

/**
 * Validation Schemas
 */
const createFeeCategorySchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).regex(/^[A-Z_]+$/),
  description: z.string().optional(),
  isRecurring: z.boolean().default(true),
  frequency: z.enum(['monthly', 'annual', 'term', 'once']).default('monthly'),
  isGeneratable: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

const createFeeAssignmentSchema = z.object({
  categoryId: z.string().min(1),
  classId: z.string().min(1),
  amount: z.union([z.string(), z.number()]).transform((v) => money(v)),
  isActive: z.boolean().default(true),
});

const createFeeRecordSchema = z.object({
  studentId: z.string().min(1),
  categoryId: z.string().min(1),
  billingPeriod: billingPeriodSchema,
  amount: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === null || v === '' ? undefined : money(v))),
  discountType: z.enum(['percentage', 'fixed']).optional(),
  discountValue: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === null || v === '' ? undefined : money(v))),
  notes: z.string().optional(),
});

const generateFeesSchema = z.object({
  categoryId: z.string().min(1),
  billingPeriod: billingPeriodSchema,
  classId: z.string().optional(),
  preview: z.boolean().default(false),
});

/** Single error shape for the whole router. */
function sendError(res: Response, error: any) {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: 'Invalid input', details: error.errors });
  }
  if (error instanceof FeeError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error?.code === 'P2002') {
    return res.status(409).json({ error: 'That record already exists.' });
  }
  if (error?.code === 'P2025') {
    return res.status(404).json({ error: 'Record not found.' });
  }
  console.error('Fee API error:', error);
  return res.status(500).json({ error: error?.message ?? 'Unexpected error' });
}

/**
 * FEE CATEGORIES ENDPOINTS
 */

/**
 * POST /fees/categories
 * Create a new fee category
 */
router.post('/categories', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const data = createFeeCategorySchema.parse(req.body);

    // Check for duplicate code
    const existing = await prisma.feeCategory.findUnique({
      where: { code: data.code },
    });

    if (existing) {
      return res.status(400).json({
        error: 'Fee category code already exists',
        code: data.code,
      });
    }

    const category = await prisma.feeCategory.create({
      data,
    });

    res.status(201).json(category);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    return sendError(res, error);
  }
});

/**
 * GET /fees/categories
 * List all fee categories
 */
router.get('/categories', authMiddleware, async (req: Request, res: Response) => {
  try {
    const categories = await prisma.feeCategory.findMany({
      orderBy: { name: 'asc' },
      include: {
        assignments: {
          where: { isActive: true },
          select: { id: true, classId: true, amount: true },
        },
      },
    });

    res.json(categories);
  } catch (error: any) {
    return sendError(res, error);
  }
});

/**
 * GET /fees/categories/:id
 * Get a specific fee category
 */
router.get('/categories/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const category = await prisma.feeCategory.findUnique({
      where: { id: req.params.id },
      include: {
        assignments: {
          where: { isActive: true },
          include: { class: true },
        },
        records: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: { student: true },
        },
      },
    });

    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.json(category);
  } catch (error: any) {
    return sendError(res, error);
  }
});

/**
 * PUT /fees/categories/:id
 * Update a fee category
 */
router.put('/categories/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const updates = createFeeCategorySchema.partial().parse(req.body);

    const category = await prisma.feeCategory.update({
      where: { id: req.params.id },
      data: updates,
    });

    res.json(category);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Category not found' });
    }
    return sendError(res, error);
  }
});

/**
 * FEE ASSIGNMENTS ENDPOINTS
 */

/**
 * POST /fees/assignments
 * Create a fee assignment (category + class + amount)
 */
router.post('/assignments', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const data = createFeeAssignmentSchema.parse(req.body);

    // Verify category and class exist
    const [category, schoolClass] = await Promise.all([
      prisma.feeCategory.findUnique({ where: { id: data.categoryId } }),
      prisma.schoolClass.findUnique({ where: { id: data.classId } }),
    ]);

    if (!category) {
      return res.status(400).json({ error: 'Category not found' });
    }
    if (!schoolClass) {
      return res.status(400).json({ error: 'Class not found' });
    }

    // Check for existing assignment
    const existing = await prisma.feeAssignment.findUnique({
      where: {
        categoryId_classId: {
          categoryId: data.categoryId,
          classId: data.classId,
        },
      },
    });

    if (existing) {
      return res.status(400).json({
        error: 'Assignment already exists for this category and class',
      });
    }

    const assignment = await prisma.feeAssignment.create({
      data,
      include: { category: true, class: true },
    });

    res.status(201).json(assignment);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    return sendError(res, error);
  }
});

/**
 * GET /fees/assignments
 * List all fee assignments with filtering
 */
router.get('/assignments', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { categoryId, classId, isActive } = req.query;

    const where: any = {};
    if (categoryId) where.categoryId = categoryId;
    if (classId) where.classId = classId;
    if (isActive !== undefined) where.isActive = isActive === 'true';

    const assignments = await prisma.feeAssignment.findMany({
      where,
      include: { category: true, class: true },
      orderBy: [{ category: { name: 'asc' } }, { class: { name: 'asc' } }],
    });

    res.json(assignments);
  } catch (error: any) {
    return sendError(res, error);
  }
});

/**
 * PUT /fees/assignments/:id
 * Update a fee assignment
 */
router.put('/assignments/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { amount, isActive } = req.body;

    const updates: any = {};
    if (amount !== undefined) updates.amount = money(amount);
    if (isActive !== undefined) updates.isActive = isActive;

    const assignment = await prisma.feeAssignment.update({
      where: { id: req.params.id },
      data: updates,
      include: { category: true, class: true },
    });

    res.json(assignment);
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    return sendError(res, error);
  }
});

/**
 * DELETE /fees/assignments/:id
 * Deactivate a fee assignment (soft delete)
 */
router.delete('/assignments/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const assignment = await prisma.feeAssignment.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ message: 'Assignment deactivated', assignment });
  } catch (error: any) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    return sendError(res, error);
  }
});

/**
 * FEE RECORDS ENDPOINTS
 */

/**
 * POST /fees/generate
 * Generate fees in bulk. Preview mode returns exactly what will be written;
 * the execute path reuses the same engine as manual creation.
 */
router.post('/generate', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const input = generateFeesSchema.parse(req.body);
    assertBillingPeriod(input.billingPeriod);

    if (input.preview) {
      const preview = await buildGenerationPreview(prisma, input);
      return res.json({ mode: 'preview', preview });
    }

    const result = await runGeneration(prisma, input);
    return res.json({ mode: 'executed', result });
  } catch (error: any) {
    return sendError(res, error);
  }
});

/**
 * POST /fees/records
 * Create a single fee record manually, using the same amount-resolution and
 * duplicate rules as bulk generation.
 */
router.post('/records', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const input = createFeeRecordSchema.parse(req.body);
    const { record, resolution } = await createFeeRecord(prisma, {
      studentId: input.studentId,
      categoryId: input.categoryId,
      billingPeriod: input.billingPeriod,
      source: 'manual',
      amountOverride: input.amount ?? null,
      discountType: input.discountType ?? null,
      discountValue: input.discountValue ?? null,
      notes: input.notes ?? null,
    });

    return res.status(201).json({ record, resolution });
  } catch (error: any) {
    return sendError(res, error);
  }
});

/**
 * GET /fees/records
 * List fee records with filtering
 */
router.get('/records', authMiddleware, async (req: Request, res: Response) => {
  try {
    const {
      studentId,
      categoryId,
      billingPeriod,
      status,
      source,
      limit = '50',
      offset = '0',
    } = req.query;

    const where: any = {};
    if (studentId) where.studentId = studentId;
    if (categoryId) where.categoryId = categoryId;
    if (billingPeriod) where.billingPeriod = billingPeriod;
    if (status) where.status = status;
    if (source) where.source = source;

    const [records, total] = await Promise.all([
      prisma.feeRecord.findMany({
        where,
        include: {
          student: {
            select: {
              id: true,
              name: true,
              admissionNo: true,
              class: true,
              section: true,
            },
          },
          category: { select: { id: true, code: true, name: true } },
          assignment: {
            select: { id: true, amount: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(parseInt(limit as string), 200),
        skip: parseInt(offset as string),
      }),
      prisma.feeRecord.count({ where }),
    ]);

    res.json({
      records,
      total,
      limit: Math.min(parseInt(limit as string), 200),
      offset: parseInt(offset as string),
    });
  } catch (error: any) {
    return sendError(res, error);
  }
});

/**
 * GET /fees/records/:id
 * Get a specific fee record with details
 */
router.get('/records/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const record = await prisma.feeRecord.findUnique({
      where: { id: req.params.id },
      include: {
        student: true,
        category: true,
        assignment: {
          include: { class: true },
        },
        override: true,
        payments: {
          include: { invoice: true },
        },
        ledgerEntries: true,
      },
    });

    if (!record) {
      return res.status(404).json({ error: 'Fee record not found' });
    }

    res.json(record);
  } catch (error: any) {
    return sendError(res, error);
  }
});

/**
 * PUT /fees/records/:id
 * Update a fee record (status/notes only)
 */
router.put('/records/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { notes, status } = req.body;

    const updates: any = {};
    if (notes !== undefined) updates.notes = notes;
    if (status) updates.status = status;

    const record = await updateFeeRecord(prisma, req.params.id, updates);

    res.json(record);
  } catch (error: any) {
    return sendError(res, error);
  }
});

/**
 * DELETE /fees/records/:id
 * Delete a fee record (only if no payments)
 */
router.delete('/records/:id', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    await deleteFeeRecord(prisma, req.params.id);
    res.json({ message: 'Fee record deleted' });
  } catch (error: any) {
    return sendError(res, error);
  }
});

/**
 * STUDENT FEE OVERRIDES ENDPOINTS
 */

/**
 * POST /fees/students/:studentId/overrides
 * Create or update a student fee override
 */
router.post(
  '/students/:studentId/overrides',
  authMiddleware,
  checkRole(['Admin']),
  async (req: Request, res: Response) => {
    try {
      const { studentId } = req.params;
      const {
        categoryId,
        billingPeriod,
        overrideAmount,
        overrideDiscount,
        discountType,
        overrideReason,
        validFrom,
        validTo,
      } = req.body;

      // Verify student and category exist
      const [student, category] = await Promise.all([
        prisma.student.findUnique({ where: { id: studentId } }),
        prisma.feeCategory.findUnique({ where: { id: categoryId } }),
      ]);

      if (!student) {
        return res.status(400).json({ error: 'Student not found' });
      }
      if (!category) {
        return res.status(400).json({ error: 'Category not found' });
      }

const period = billingPeriod ? String(billingPeriod) : null;
      if (period) assertBillingPeriod(period);
      if (overrideReason === undefined || overrideReason === null || overrideReason === '') {
        return res.status(400).json({ error: 'An override reason is required for audit purposes.' });
      }

      // NULL billingPeriod rows are standing overrides; PostgreSQL composite unique
      // indexes treat NULLs as distinct, so dedupe them here in the service layer.
      const existing = await prisma.studentFeeOverride.findFirst({
        where: {
          studentId,
          categoryId,
          billingPeriod: period,
          ...(period ? {} : { billingPeriod: null }),
        },
      });

      const payload = {
        overrideAmount: overrideAmount ? money(overrideAmount) : null,
        overrideDiscount: overrideDiscount ? money(overrideDiscount) : null,
        discountType: discountType || null,
        overrideReason: String(overrideReason),
        validFrom: validFrom ? new Date(validFrom) : new Date(),
        validTo: validTo ? new Date(validTo) : null,
      };

      const override = existing
        ? await prisma.studentFeeOverride.update({
            where: { id: existing.id },
            data: { ...payload, updatedAt: new Date() },
            include: { student: true, category: true },
          })
        : await prisma.studentFeeOverride.create({
            data: {
              studentId,
              categoryId,
              billingPeriod: period,
              ...payload,
              approvedBy: (req as any).user?.id ?? null,
            },
            include: { student: true, category: true },
          });

      return res.status(existing ? 200 : 201).json(override);
    } catch (error: any) {
      return sendError(res, error);
    }
  },
);

/**
 * GET /fees/students/:studentId/overrides
 * Get all fee overrides for a student
 */
router.get('/students/:studentId/overrides', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { studentId } = req.params;

    const overrides = await prisma.studentFeeOverride.findMany({
      where: { studentId },
      include: { category: true },
      orderBy: { createdAt: 'desc' },
    });

    res.json(overrides);
  } catch (error: any) {
    return sendError(res, error);
  }
});

/**
 * DELETE /fees/students/:studentId/overrides/:overrideId
 * Remove a fee override
 */
router.delete(
  '/students/:studentId/overrides/:overrideId',
  authMiddleware,
  checkRole(['Admin']),
  async (req: Request, res: Response) => {
    try {
      const { overrideId } = req.params;

      await prisma.studentFeeOverride.delete({
        where: { id: overrideId },
      });

      res.json({ message: 'Override deleted' });
    } catch (error: any) {
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Override not found' });
      }
      return sendError(res, error);
    }
  }
);

export default router;
