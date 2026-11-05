import { Request, Response, NextFunction } from 'express';

// Finance routes an Accountant may access. Anything outside this list stays
// Admin/Teacher/Student/Parent only.
const FINANCE_PATH_RE = new RegExp(
  '^\\/(fees|invoices|payments|salaries|expenses|finance|dashboard\\/financial-details|dashboard\\/stats|students\\/[^/]+\\/fees)(\\/|$)',
);

export const checkRole = (roles: Array<string>) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    const originalUrl = (req.originalUrl || req.url || '').split('?')[0];

    if (!user) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Accountant can act like Admin only on finance routes; nothing else.
    if (user.role === 'Accountant') {
      if (!roles.includes('Admin') || !FINANCE_PATH_RE.test(originalUrl)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
      return next();
    }

    if (!roles.includes(user.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    next();
  };
};
