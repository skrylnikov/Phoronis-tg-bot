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

  logger.info(
    { event: 'message.private_cleanup_completed', deletedCount: result.count },
    'Private message cleanup completed',
  );
  return result.count;
}
