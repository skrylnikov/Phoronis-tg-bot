import { Composer } from 'grammy';
import type { BotContext } from '../bot';
import { findChatByIdRepo, updateChatRepo } from '../repositories';

export const privateController = new Composer<BotContext>();

privateController.command('private', async (ctx) => {
  if (!ctx.chatId || !ctx.from) return;

  if (ctx.chat.type !== 'private') {
    await ctx.reply('❌ Приватный режим можно включать только в личных чатах');
    return;
  }

  const chat = await findChatByIdRepo(BigInt(ctx.chatId), {
    privateModeEnabled: true,
  });

  if (!chat) {
    await ctx.reply('❌ Чат не найден');
    return;
  }

  const newValue = !chat.privateModeEnabled;

  await updateChatRepo(BigInt(ctx.chatId), {
    privateModeEnabled: newValue,
  });

  const status = newValue ? '✅ Включён' : '❌ Выключен';
  await ctx.reply(
    `Приватный режим ${status}\n\n${newValue ? 'В этом режиме ваши сообщения в данном чате не используются в контексте. Приватные сообщения автоматически удаляются через 7 дней.' : 'Теперь ваши сообщения в этом чате могут использоваться в контексте.'}`,
  );
});
