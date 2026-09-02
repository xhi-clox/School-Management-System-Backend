import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: 'Authorization header missing' });
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Token missing' });
  }

  // Try primary secret, then fallbacks for old tokens (fallback-secret vs fallback-jwt-secret-for-development)
  const tryVerify = (t: string, secret: string) => {
    try { return jwt.verify(t, secret) as { userId: string; role: string }; } catch { return null; }
  };
  let decoded = tryVerify(token, (process.env.JWT_SECRET as string) || 'fallback-jwt-secret-for-development');
  if (!decoded) decoded = tryVerify(token, 'fallback-secret');
  if (!decoded) decoded = tryVerify(token, 'fallback-jwt-secret-for-development');
  try {
    if (!decoded) throw new Error('Invalid token');
    // decoded already obtained
    let user = null;

    // Find user based on role
    if (decoded.role === 'Admin') {
      user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    } else if (decoded.role === 'Teacher') {
      const teacher = await prisma.teacher.findUnique({ where: { id: decoded.userId } });
      if (teacher) {
        user = {
          id: teacher.id,
          email: teacher.email,
          role: 'Teacher',
          name: teacher.name,
          subject: teacher.subject
        };
      }
    } else if (decoded.role === 'Student') {
      const student = await prisma.student.findUnique({ where: { id: decoded.userId } });
      if (student) {
        user = {
          id: student.id,
          email: student.email,
          role: 'Student',
          name: student.name,
          admissionNo: student.admissionNo
        };
      }
    }

    if (!user) {
      return res.status(401).json({ message: 'Invalid token - user not found' });
    }

    (req as any).user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};
