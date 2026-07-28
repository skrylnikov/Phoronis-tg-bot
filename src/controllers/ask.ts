import { aiController } from '../ai';
import { describeTelegramPhoto } from '../ai/image-description';
import type { BotContext } from '../bot';
import { prisma } from '../db';
import { releaseQuota, reserveQuota, saveChat, saveUser } from '../shared';
import { sendMediaLimitNotice } from './limit-notice';

const usageText = 'Использование: /ask ваш вопрос';

export function extractAskQuestion(text: string): string {
  return text.replace(/^\/ask(?:@[a-z0-9_]+)?(?:\s+|$)/i, '').trim();
}

export const askController = async (ctx: BotContext) => {
  const chat = ctx.chat;
  if (!ctx.from || !chat || !ctx.chatId || !ctx.msg?.text) {
    return;
  }

  if (chat.type === 'private') {
    await ctx.reply('Команда /ask доступна только в группах.');
    return;
  }

  if (chat.type !== 'group' && chat.type !== 'supergroup') {
    return;
  }

  const question = extractAskQuestion(ctx.msg.text);
  if (!question) {
    await ctx.reply(usageText, {
      receiver_user_id: ctx.from.id,
      ...(ctx.msg.ephemeral_message_id
        ? {
            reply_parameters: {
              ephemeral_message_id: ctx.msg.ephemeral_message_id,
            },
          }
        : {}),
    });
    return;
  }

  let imageDescription: string | undefined;
  const repliedPhoto = ctx.msg.reply_to_message?.photo;
  if (repliedPhoto) {
    await Promise.all([saveChat(chat), saveUser(ctx.from), saveUser(ctx.me)]);
    const sourceMessageId = ctx.msg.reply_to_message?.message_id ?? 0;
    const savedReply = await prisma.message.findUnique({
      where: { chatId_id: { chatId: ctx.chatId, id: sourceMessageId } },
      select: { summary: true },
    });
    imageDescription = savedReply?.summary ?? undefined;
    if (!imageDescription) {
      const reservation = await reserveQuota({
        userId: ctx.from.id,
        chatId: ctx.chatId,
        isGroup: true,
        kind: 'IMAGE',
      });
      if (!reservation.allowed) {
        await sendMediaLimitNotice(ctx, 'IMAGE_LIMIT');
        return;
      }
      try {
        const photo = repliedPhoto.reduce((best, candidate) =>
          Math.min(candidate.width, candidate.height) <= 896 &&
          Math.min(candidate.width, candidate.height) >
            Math.min(best.width, best.height)
            ? candidate
            : best,
        );
        imageDescription = await describeTelegramPhoto(ctx, photo);
        if (savedReply) {
          await prisma.message.update({
            where: { chatId_id: { chatId: ctx.chatId, id: sourceMessageId } },
            data: { summary: imageDescription },
          });
        }
      } catch (error) {
        await releaseQuota(reservation);
        throw error;
      }
    }
  }

  await aiController(ctx, imageDescription, undefined, undefined, {
    messageText: question,
    ephemeralReceiverUserId: ctx.from.id,
    persistResponse: false,
    readOnlyTools: true,
    resolveContext: true,
  });
};
