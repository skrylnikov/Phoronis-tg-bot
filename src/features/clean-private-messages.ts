import { prisma } from '../db';
import { logger } from '../logger';

export async function cleanOldPrivateMessages(): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const result = await prisma.message.deleteMany({
    where: {
      private: true,
      sentAt: { lt: sevenDaysAgo },
    },
  });

  logger.info(`Удалено ${result.count} приватных сообщений старше 7 дней`);
  return result.count;
}
