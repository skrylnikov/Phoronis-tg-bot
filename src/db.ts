import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { logger } from './logger';

const connectionString = process.env.DATABASE_URL || '';

const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });

prisma
  .$connect()
  .then(() => {
    logger.info({ event: 'database.connected' }, 'Connected to database');
  })
  .catch((error) => {
    logger.error(
      { event: 'database.connection_failed', err: error },
      'Error connecting to database',
    );
  });
