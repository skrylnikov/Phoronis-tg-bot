import { Context } from "grammy";

import { prisma } from "../db";

export const newChatMembersController = async (ctx: Context) => {
  const chat = await prisma.chat.findUnique({
    where: {
      id: ctx.chat?.id,
    },
  });

  if (chat?.greeting) {
    const reply = await ctx.reply(chat.greeting, {
      reply_to_message_id: ctx.message?.message_id,
    });
    await prisma.message.create({
      data: {
        id: reply.message_id,
        chatId: ctx.chatId!,
        senderId: reply.from!.id,
        sentAt: new Date(reply.date * 1000),
        messageType: "TEXT",
        text: chat.greeting,
      },
    });
  }
};
