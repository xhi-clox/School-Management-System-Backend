import { PrismaClient } from '@prisma/client'
import 'dotenv/config'

const p = new PrismaClient()
async function main() {
  await p.holiday.create({ data: { name: 'Debug Holiday', startDate: new Date('2026-11-10T00:00:00Z') } })
  const startUtc = new Date('2026-11-09T00:00:00Z')
  const endUtc = new Date('2026-11-11T00:00:00Z')
  const rows = await p.holiday.findMany({
    where: {
      startDate: { lte: endUtc },
      OR: [{ endDate: { gte: startUtc } }, { AND: [{ endDate: null }, { startDate: { gte: startUtc } }] }],
    },
  })
  console.log('client-p OR query:', rows.map((x) => ({ id: x.id, name: x.name })))
  await p.holiday.deleteMany({ where: { name: 'Debug Holiday' } })
}
main().finally(() => p.$disconnect())
