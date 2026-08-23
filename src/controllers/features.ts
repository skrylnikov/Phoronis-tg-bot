import { Composer } from 'grammy';
import type { BotContext } from '../bot';
import { sendInktoberMessage } from '../features/inktober';
import { sendSelfieSaturdayMessage } from '../features/selfie-saturday';
import { logger } from '../logger';
import {
  countMessagesWithWhereRepo,
  findChatByIdRepo,
  updateChatRepo,
  upsertChatFeatureRepo,
} from '../repositories';

export const featuresController = new Composer<BotContext>();

// Вспомогательная функция для проверки прав администратора
async function isAdmin(ctx: BotContext): Promise<boolean> {
  if (!ctx.chat || ctx.chat.type === 'private') {
    return false;
  }
  if (!ctx.from) {
    return false;
  }

  const member = await ctx.getChatMember(ctx.from.id);
  return ['administrator', 'creator'].includes(member.status);
}

// Команда для включения фич
featuresController.command('enable', async (ctx) => {
  const feature = ctx.match?.toLowerCase();

  if (!ctx.chat || ctx.chat.type === 'private') {
    await ctx.reply('Эту команду можно использовать только в группах.');
    return;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply('Только администраторы могут включать функции.');
    return;
  }

  try {
    if (feature === 'selfiesaturday') {
      await upsertChatFeatureRepo(BigInt(ctx.chat.id), 'selfieSaturday', true, {
        title: ctx.chat.title,
        chatType: 'GROUP',
      });
      await ctx.reply("Функция 'Селфи Суббота' включена для этого чата! 🎉");
    } else if (feature === 'inktober') {
      await upsertChatFeatureRepo(BigInt(ctx.chat.id), 'inktober', true, {
        title: ctx.chat.title,
        chatType: 'GROUP',
      });
      await ctx.reply("Функция 'Inktober' включена для этого чата! 🎨");
    } else {
      await ctx.reply(
        'Доступные функции: selfiesaturday, inktober\nИспользование: /enable <название_функции>',
      );
    }
  } catch (error) {
    logger.error(
      { event: 'feature.enable_failed', feature, err: error },
      'Feature enable failed',
    );
    await ctx.reply('Произошла ошибка при включении функции.');
  }
});

// Команда для выключения фич
featuresController.command('disable', async (ctx) => {
  const feature = ctx.match?.toLowerCase();

  if (!ctx.chat || ctx.chat.type === 'private') {
    await ctx.reply('Эту команду можно использовать только в группах.');
    return;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply('Только администраторы могут выключать функции.');
    return;
  }

  try {
    if (feature === 'selfiesaturday') {
      await updateChatRepo(BigInt(ctx.chat.id), {
        selfieSaturdayEnabled: false,
      });
      await ctx.reply("Функция 'Селфи Суббота' выключена для этого чата.");
    } else if (feature === 'inktober') {
      await updateChatRepo(BigInt(ctx.chat.id), { inktoberEnabled: false });
      await ctx.reply("Функция 'Inktober' выключена для этого чата.");
    } else {
      await ctx.reply(
        'Доступные функции: selfiesaturday, inktober\nИспользование: /disable <название_функции>',
      );
    }
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'P2025'
    ) {
      await ctx.reply(
        `Функция '${feature}' уже была выключена или чат не найден.`,
      );
    } else {
      logger.error(
        { event: 'feature.disable_failed', feature, err: error },
        'Feature disable failed',
      );
      await ctx.reply('Произошла ошибка при выключении функции.');
    }
  }
});

// Команда для тестирования фич
featuresController.command('test', async (ctx) => {
  const feature = ctx.match?.toLowerCase();

  if (!ctx.chat || ctx.chat.type === 'private') {
    await ctx.reply('Эту команду можно использовать только в группах.');
    return;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply('Только администраторы могут тестировать функции.');
    return;
  }

  try {
    if (feature === 'selfiesaturday') {
      await ctx.reply("Тестируем отправку сообщения 'Селфи Суббота'...");
      await sendSelfieSaturdayMessage(ctx.chat.id);
    } else if (feature === 'inktober') {
      await ctx.reply("Тестируем отправку сообщения 'Inktober'...");
      await sendInktoberMessage(ctx.chat.id);
    } else {
      await ctx.reply(
        'Доступные функции для тестирования: selfiesaturday, inktober\nИспользование: /test <название_функции>',
      );
    }
  } catch (error) {
    logger.error(
      { event: 'feature.test_failed', feature, err: error },
      'Feature test failed',
    );
    await ctx.reply('Произошла ошибка при тестировании функции.');
  }
});

// Команда для просмотра статуса всех фич
featuresController.command('status', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') {
    await ctx.reply('Эту команду можно использовать только в группах.');
    return;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply(
      'Только администраторы могут просматривать статус функций.',
    );
    return;
  }

  try {
    const chat = await findChatByIdRepo(BigInt(ctx.chat.id), {
      id: true,
      title: true,
      selfieSaturdayEnabled: true,
      inktoberEnabled: true,
      greeting: true,
    });

    if (!chat) {
      await ctx.reply('Чат не найден в базе данных.');
      return;
    }

    const status =
      `📊 Статус функций в этом чате:\n\n` +
      `🎉 Селфи Суббота: ${
        chat.selfieSaturdayEnabled ? '✅ Включена' : '❌ Выключена'
      }\n` +
      `🎨 Inktober: ${
        chat.inktoberEnabled ? '✅ Включена' : '❌ Выключена'
      }\n\n` +
      `Использование команд:\n` +
      `/enable <функция> - включить функцию\n` +
      `/disable <функция> - выключить функцию\n` +
      `/test <функция> - протестировать функцию\n` +
      `/status - показать этот статус`;

    await ctx.reply(status);
  } catch (error) {
    logger.error(
      { event: 'feature.status_failed', err: error },
      'Feature status lookup failed',
    );
    await ctx.reply('Произошла ошибка при получении статуса функций.');
  }
});

featuresController.command('index', async (_ctx) => {
  try {
    const _count = await countMessagesWithWhereRepo({});
    // // const count = 1000;
    // for (let i = 138800; i < count; i += 100) {
    //   logger.info({ event: 'feature.index_progress', offset: i, count });
    //   const messages = await prisma.message.findMany({
    //     skip: i,
    //     take: 100,
    //     include: {
    //       replyToMessage: true,
    //     }
    //   });
    //   const request = messages
    //     .map((message) => {
    //       const replyMessage = message.replyToMessage;
    //       const replyToMessageText =
    //       replyMessage?.text?.trim() ||
    //         replyMessage?.summary?.trim() ||
    //         null;
    //       const messageText = (message.text || message.summary || "").trim();
    //       const content = replyToMessageText
    //         ? `Q: "${replyToMessageText}" \n\n A: "${messageText}"`
    //         : messageText;
    //       if (messageText.length <= 10 && (replyToMessageText === null || replyToMessageText.length <= 10)) {
    //         return null;
    //       }
    //       return {
    //         id: Number(message.id),
    //         text: messageText,
    //         content,
    //         chatId: Number(message.chatId),
    //         userId: Number(message.senderId),
    //       };
    //     })
    //     .filter((message) => message);
    // }
    // await ctx.reply("Индексация завершена");
  } catch (error) {
    logger.error(
      { event: 'feature.index_failed', err: error },
      'Feature index failed',
    );
  }
});
