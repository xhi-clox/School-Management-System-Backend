/*
 * Thrown by Prisma when a query selects a column the database does not have.
 * That happens whenever schema.prisma gains a field before its migration has
 * been applied - a normal state during development, since the migration is
 * deployed separately.
 */
const isMissingColumn = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  'code' in err &&
  (err as { code?: unknown }).code === 'P2022';

export default isMissingColumn;