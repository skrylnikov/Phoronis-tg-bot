import { Composer } from "grammy";

import { saveChat, saveUser } from "../shared";
import { prisma } from "../db";
import { BotContext } from "../bot";
import { aiController } from "../ai";

export const processMessageController = new Composer<BotContext>();

processMessageController.on(":text", async (ctx) => {
  try {
    console.log("processMessageController");
    await Promise.all([
      saveChat(ctx.chat),
      saveUser(ctx.from!),
      saveUser(ctx.me),
    ]);

    const chat = await prisma.chat.findUnique({
      where: {
        id: ctx.chatId,
      },
    });

    if (chat?.greeting) {
      await prisma.message.create({
        data: {
          id: ctx.msg.message_id,
          chatId: ctx.chatId,
          senderId: ctx.from!.id,
          replyToMessageId: ctx.msg?.reply_to_message?.message_id,
          sentAt: new Date(ctx.msg.date * 1000),
          text: ctx.msg.text,
          messageType: "TEXT",
        },
      });
    }

    if (
      ctx.msg.text.toLowerCase().startsWith("ио") ||
      ctx.msg.reply_to_message?.from?.id === ctx.me.id
    ) {
      await aiController(ctx);
    }
  } catch (error) {
    console.error(error);
  }
});
