import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { logger } from './logger';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL || '',
});

export const prisma = new PrismaClient({ adapter });

export async function connectPrismaRepo(): Promise<void> {
  await prisma.$connect();
  logger.info({ event: 'database.connected' }, 'Connected to database');
}

export async function checkPrismaRepo(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export async function disconnectPrismaRepo(): Promise<void> {
  await prisma.$disconnect();
  logger.info({ event: 'database.disconnected' }, 'Disconnected from database');
}
