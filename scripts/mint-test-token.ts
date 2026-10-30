import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

/**
 * Mints a short-lived token for the existing admin account so the new fee
 * endpoints can be smoke-tested over HTTP without needing a password.
 */
const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: 'Admin' } });
  if (!admin) throw new Error('No Admin user found');

  // Never fall back to a hardcoded secret. A literal committed to the repo
  // becomes the live signing key for anyone who clones it, which would let them
  // mint their own Admin tokens. Fail loudly instead.
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. Refusing to mint a token rather than signing with a ' +
        'known fallback secret. Set JWT_SECRET in .env first.',
    );
  }
  const token = jwt.sign(
    { userId: admin.id, email: admin.email, role: 'Admin' },
    secret,
    { expiresIn: '30m' },
  );
  console.log(token);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());