import { Composer } from 'grammy';
import type { BotContext } from '../bot';
import { prisma } from '../db';

export const privateController = new Composer<BotContext>();

privateController.command('private', async (ctx) => {
  if (!ctx.chatId || !ctx.from) return;

  if (ctx.chat.type !== 'private') {
    await ctx.reply('❌ Приватный режим можно включать только в личных чатах');
    return;
  }

  const chat = await prisma.chat.findUnique({
    where: { id: ctx.chatId },
    select: { privateModeEnabled: true },
  });

  if (!chat) {
    await ctx.reply('❌ Чат не найден');
    return;
  }

  const newValue = !chat.privateModeEnabled;

  await prisma.chat.update({
    where: { id: ctx.chatId },
    data: { privateModeEnabled: newValue },
  });

  const status = newValue ? '✅ Включён' : '❌ Выключен';
  await ctx.reply(
    `Приватный режим ${status}\n\n${newValue ? 'В этом режиме ваши сообщения в данном чате не используются в контексте. Приватные сообщения автоматически удаляются через 7 дней.' : 'Теперь ваши сообщения в этом чате могут использоваться в контексте.'}`,
  );
});
