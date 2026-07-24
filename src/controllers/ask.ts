import { aiController } from '../ai';
import type { BotContext } from '../bot';

const usageText = 'Использование: /ask ваш вопрос';

export function extractAskQuestion(text: string): string {
  return text.replace(/^\/ask(?:@[a-z0-9_]+)?(?:\s+|$)/i, '').trim();
}

export const askController = async (ctx: BotContext) => {
  const chat = ctx.chat;
  if (!ctx.from || !chat || !ctx.msg?.text) {
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
    await ctx.reply(usageText, { receiver_user_id: ctx.from.id });
    return;
  }

  await aiController(ctx, undefined, undefined, undefined, {
    messageText: question,
    ephemeralReceiverUserId: ctx.from.id,
    persistResponse: false,
    readOnlyTools: true,
    resolveContext: true,
  });
};
