import type { BotContext } from '../../bot';
import { logger } from '../../logger';
import { releaseQuota, reserveQuota } from '../quota-service';
import { analyzeUserMetaInfo } from './fact-analyzer';
import {
  countMessagesRepo,
  findMessagesRepo,
} from '../../repositories/message-repository';

function isGroupChat(ctx: BotContext): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

export async function analyzeUserMessages(ctx: BotContext): Promise<void> {
  if (!ctx.from || !ctx.chatId) return;

  const messageCount = await countMessagesRepo({
    chatId: ctx.chatId,
    senderId: ctx.from.id,
    private: false,
  });
  if (messageCount % 30 !== 0) return;

  const reservation = await reserveQuota({
    userId: ctx.from.id,
    chatId: ctx.chatId,
    isGroup: isGroupChat(ctx),
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
      chatId: ctx.chatId,
      senderId: ctx.from.id,
      private: false,
    });
    await analyzeUserMetaInfo(BigInt(ctx.from.id), lastMessages.reverse());
  } catch (error) {
    await releaseQuota(reservation);
    throw error;
  }
}
