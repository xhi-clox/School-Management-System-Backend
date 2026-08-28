import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const admins = await prisma.user.findMany({ where: { role: 'Admin' } });

  const seedItems = [
    {
      title: 'Welcome to NexGrad',
      body: 'Your School Management System is ready. Explore the dashboard to get started.',
    },
    {
      title: 'New academic year',
      body: 'You can set up the new academic year and class routine from the Settings page.',
    },
  ];

  for (const admin of admins) {
    for (const item of seedItems) {
      const existing = await prisma.notification.findFirst({
        where: { userId: admin.id, title: item.title },
      });
      if (!existing) {
        await prisma.notification.create({
          data: { userId: admin.id, title: item.title, body: item.body },
        });
      }
    }
  }

  const count = admins.length;
  console.log(`Seeded notifications for ${count} admin(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
