import { releaseQuota, reserveQuota } from '../domain/quota-service';
import { analyzeUserMetaInfo } from '../domain/user/fact-analyzer';
import { logger } from '../logger';
import { enqueueBackgroundJobRepo } from '../repositories/background-job-repository';
import {
  countMessagesRepo,
  findMessagesRepo,
} from '../repositories/message-repository';

export async function scheduleUserMessageAnalysis(input: {
  userId: number;
  chatId: number;
  isGroup: boolean;
}): Promise<void> {
  const messageCount = await countMessagesRepo({
    chatId: BigInt(input.chatId),
    senderId: BigInt(input.userId),
    private: false,
  });
  if (messageCount % 30 !== 0) return;

  await enqueueBackgroundJobRepo({
    type: 'USER_MESSAGE_ANALYSIS',
    dedupeKey: `user-analysis:${input.chatId}:${input.userId}:${messageCount}`,
    payload: {
      userId: String(input.userId),
      chatId: String(input.chatId),
      isGroup: input.isGroup,
    },
  });
}

export async function analyzeUserMessagesForUser(input: {
  userId: number;
  chatId: number;
  isGroup: boolean;
}): Promise<void> {
  const reservation = await reserveQuota({
    userId: input.userId,
    chatId: input.chatId,
    isGroup: input.isGroup,
    kind: 'ANALYSIS',
  });
  if (!reservation.allowed) {
    logger.debug(
      { event: 'user_meta.analysis_quota_exceeded' },
      'User meta analysis quota exceeded',
    );
    return;
  }

  try {
    const lastMessages = await findMessagesRepo({
      chatId: BigInt(input.chatId),
      senderId: BigInt(input.userId),
      private: false,
    });
    await analyzeUserMetaInfo(BigInt(input.userId), lastMessages.reverse());
  } catch (error) {
    await releaseQuota(reservation);
    throw error;
  }
}
