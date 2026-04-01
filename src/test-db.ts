import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function test() {
  try {
    console.log('Testing connection...');
    await prisma.$connect();
    console.log('Connected.');
    
    console.log('Checking Product model...');
    const count = await prisma.product.count();
    console.log('Product count:', count);
    
    console.log('Success.');
  } catch (e: any) {
    console.error('TEST FAILED:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

test();
