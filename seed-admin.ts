import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// The password is never hardcoded here; a literal in this file would publish a
// working Admin credential. Supply it via the environment instead.
const ADMIN_EMAIL = process.env.ADMIN_SEED_EMAIL || 'admin@sms.local';

async function main() {
  try {
    const password = process.env.ADMIN_SEED_PASSWORD;
    if (!password) {
      throw new Error(
        'ADMIN_SEED_PASSWORD is not set. Refusing to create an Admin with a known ' +
          'default password. Set ADMIN_SEED_PASSWORD in .env first.',
      );
    }

    // Check if admin already exists
    const existingAdmin = await prisma.user.findFirst({
      where: { email: ADMIN_EMAIL }
    });

    if (existingAdmin) {
      console.log('Admin user already exists');
      return;
    }

    // Create admin user
    const hashedPassword = await bcrypt.hash(password, 10);
    const admin = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        password: hashedPassword,
        role: 'Admin',
        name: 'System Administrator',
        department: 'Administration',
        designation: 'Administrator'
      }
    });

    console.log('�o. Admin user created successfully:');
    console.log(`   Email: ${ADMIN_EMAIL}`);
    console.log('   Password: (value of ADMIN_SEED_PASSWORD, bcrypt-hashed)');
    console.log('   Role: Admin');

  } catch (error) {
    console.error('Error seeding admin:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();

