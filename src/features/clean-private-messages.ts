import { logger } from '../logger';
import { deleteOldPrivateMessagesRepo } from '../repositories/message-repository';

export async function cleanOldPrivateMessages(): Promise<number> {
  const count = await deleteOldPrivateMessagesRepo();

  logger.info(
    { event: 'message.private_cleanup_completed', deletedCount: count },
    'Private message cleanup completed',
  );
  return count;
}
