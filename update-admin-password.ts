import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.ADMIN_SEED_EMAIL || 'admin@sms.local';

async function main() {
  try {
    const password = process.env.ADMIN_SEED_PASSWORD;
    if (!password) {
      throw new Error(
        'ADMIN_SEED_PASSWORD is not set. Refusing to set an Admin password from a ' +
          'hardcoded literal. Set ADMIN_SEED_PASSWORD in .env first.',
      );
    }

    // This previously wrote the password in plain text, bypassing bcrypt, while
    // every other write path (registration, seeding) stores a hash. Anything
    // comparing with bcrypt would reject the account outright, and anything
    // reading the column directly would see the password. Hash it.
    const hashedPassword = await bcrypt.hash(password, 10);
    const admin = await prisma.user.update({
      where: { email: ADMIN_EMAIL },
      data: {
        password: hashedPassword,
      },
    });

    console.log('✅ Admin password updated (bcrypt-hashed)');
    console.log(`Email: ${ADMIN_EMAIL}`);
    console.log('Password: (value of ADMIN_SEED_PASSWORD, not printed)');

  } catch (error) {
    console.error('Error:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
