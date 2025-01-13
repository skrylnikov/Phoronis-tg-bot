import { Composer } from "grammy";

import { saveChat, saveUser } from "../shared";
import { prisma } from "../db";
import { BotContext } from "../bot";
import { aiController } from "../ai";
import { token } from "../config";

export const processMessageController = new Composer<BotContext>();

processMessageController.on(":text", async (ctx) => {
  try {
    console.log("processMessageController text");
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

    if (chat?.greeting || ctx.chat.type === "private") {
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
      ctx.msg.reply_to_message?.from?.id === ctx.me.id ||
      ctx.chat.type === "private"
    ) {
      await aiController(ctx);
    }
  } catch (error) {
    console.error(error);
  }
});

processMessageController.on(":photo", async (ctx) => {
  try {
    console.log("processMessageController photo");
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

    const media = await Promise.all(
      ctx.msg.photo?.map(async (photo) => {
        const fileLink = await ctx.api.getFile(photo.file_id);

        return `https://api.telegram.org/file/bot${token}/${fileLink.file_path}`;
      }) || []
    );

    if (chat?.greeting || ctx.chat.type === "private") {
      await prisma.message.create({
        data: {
          id: ctx.msg.message_id,
          chatId: ctx.chatId,
          senderId: ctx.from!.id,
          replyToMessageId: ctx.msg?.reply_to_message?.message_id,
          sentAt: new Date(ctx.msg.date * 1000),
          text: ctx.msg.caption,
          messageType: "MEDIA",
          media: JSON.stringify(media),
        },
      });
    }
  } catch (error) {
    console.error(error);
  }
});
