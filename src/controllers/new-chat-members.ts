import type { Context } from 'grammy';

import { prisma } from '../db';
import { saveMessage } from '../shared';

export const newChatMembersController = async (ctx: Context) => {
  const chat = await prisma.chat.findUnique({
    where: {
      id: ctx.chat?.id,
    },
  });

  if (chat?.greeting && ctx.chat) {
    const reply = await ctx.reply(chat.greeting, {
      reply_to_message_id: ctx.message?.message_id,
    });
    await saveMessage({
      id: reply.message_id,
      chatId: ctx.chat.id,
      senderId: reply.from?.id ?? 0,
      replyToMessageId: ctx.message?.message_id,
      sentAt: new Date(reply.date * 1000),
      messageType: 'TEXT',
      text: chat.greeting,
    });
  }
};
