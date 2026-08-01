import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { logger } from '../logger';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
const deadline = Date.now() + 10 * 60 * 1000;
let ready = false;

try {
  while (Date.now() < deadline) {
    try {
      const extensions = await prisma.$queryRaw<Array<{ installed: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'vector'
        ) AS installed
      `;

      if (extensions[0]?.installed) {
        logger.info(
          { event: 'database.vector_extension_ready' },
          'PostgreSQL vector extension is ready',
        );
        ready = true;
        break;
      }
    } catch (err) {
      logger.warn(
        { event: 'database.unavailable', err },
        'PostgreSQL is unavailable; retrying vector readiness check',
      );
    }

    logger.info(
      { event: 'database.waiting_for_vector_extension' },
      'Waiting for PostgreSQL vector extension',
    );
    await Bun.sleep(2_000);
  }

  if (!ready) {
    throw new Error('Timed out waiting for PostgreSQL vector extension');
  }
} finally {
  await prisma.$disconnect();
}
