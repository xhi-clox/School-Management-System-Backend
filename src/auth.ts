import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from './prisma';

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: 'Authorization header missing' });
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Token missing' });
  }

  // Require JWT_SECRET to be set; do not accept tokens signed with fallback secrets
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return res.status(500).json({ message: 'Server misconfigured: JWT_SECRET is not set' });
  }

  const tryVerify = (t: string, secret: string) => {
    try { return jwt.verify(t, secret) as { userId: string; role: string }; } catch { return null; }
  };
  let decoded = tryVerify(token, jwtSecret);
  try {
    if (!decoded) throw new Error('Invalid token');
    // decoded already obtained
    let user = null;

    // Find user based on role. Accountant is an Admin-scoped finance role: they
    // authenticate against the same users table and are authorised per route by
    // checkRole() below, not given blanket Admin access.
    if (decoded.role === 'Admin' || decoded.role === 'Accountant') {
      const userRecord = await prisma.user.findUnique({ where: { id: decoded.userId } });
      if (userRecord) {
        user = {
          id: userRecord.id,
          email: userRecord.email,
          role: userRecord.role,
          name: userRecord.name,
        };
      }
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
