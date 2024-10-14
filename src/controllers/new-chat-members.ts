import { Context } from "grammy";

import { prisma } from "../db";

export const newChatMembersController = async (ctx: Context) => {
  const chat = await prisma.chat.findUnique({
    where: {
      id: ctx.chat?.id,
    },
  });

  if (chat?.greeting) {
    return ctx.reply(chat.greeting, {
      reply_to_message_id: ctx.message?.message_id,
    });
  }
};
