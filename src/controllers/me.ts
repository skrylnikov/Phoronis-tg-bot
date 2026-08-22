import type { Context } from 'grammy';
import { saveMessage } from '../domain';
import { logger } from '../logger';

export const meController = async (ctx: Context) => {
  try {
    if (ctx.message?.text && ctx.from) {
      const text = ctx.message.text.replace('/me', '').trim();

      const username = `[${ctx.from.first_name || ctx.from.last_name || ctx.from.username || 'Неопознаный юзер'}](tg://user?id=${ctx.from.id})`;
      const result = `${username} *${text}*`;

      const reply = await ctx.reply(result, { parse_mode: 'Markdown' });
      await ctx.api.deleteMessage(ctx.message.chat.id, ctx.message.message_id);

      await saveMessage({
        id: reply.message_id,
        chatId: ctx.message.chat.id,
        senderId: reply.from?.id ?? 0,
        sentAt: new Date(reply.date * 1000),
        messageType: 'TEXT',
        text: result,
      });
    }
  } catch (err) {
    logger.error({ event: 'command.me_failed', err }, 'Failed to process /me');
  }
};
