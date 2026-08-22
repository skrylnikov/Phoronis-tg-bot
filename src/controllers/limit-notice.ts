import type { BotContext } from '../bot';
import { createPurchaseSession, shouldSendLimitNotice } from '../domain';

function isGroupChat(ctx: BotContext): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

export async function sendMediaLimitNotice(
  ctx: BotContext,
  kind: 'IMAGE_LIMIT' | 'VOICE_LIMIT',
): Promise<void> {
  if (!ctx.from || !ctx.chatId) return;
  const shouldSend = await shouldSendLimitNotice({
    userId: ctx.from.id,
    chatId: ctx.chatId,
    kind,
  });
  if (!shouldSend) return;

  const session = await createPurchaseSession({
    userId: ctx.from.id,
    beneficiaryChatId: ctx.chatId,
  });
  const username = ctx.me.username;
  const subscribeUrl = username
    ? `https://t.me/${username}?start=buy_${session.token}`
    : undefined;
  const ephemeralMessageId = ctx.msg?.ephemeral_message_id;
  await ctx.reply(
    kind === 'IMAGE_LIMIT'
      ? 'Лимит распознавания изображений исчерпан. Подписка даст больше распознаваний.'
      : 'Лимит распознавания голосовых сообщений исчерпан. Подписка даст больше расшифровок.',
    {
      ...(isGroupChat(ctx) && ephemeralMessageId
        ? {
            receiver_user_id: ctx.from.id,
            reply_parameters: { ephemeral_message_id: ephemeralMessageId },
          }
        : {}),
      ...(subscribeUrl
        ? {
            reply_markup: {
              inline_keyboard: [[{ text: 'Подписка', url: subscribeUrl }]],
            },
          }
        : {}),
    },
  );
}
