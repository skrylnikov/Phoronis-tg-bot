import { Composer } from "grammy";
import { logger } from "../logger";

import { saveChat, saveUser } from "../shared";
import { prisma } from "../db";
import { BotContext } from "../bot";
import { aiController } from "../ai";
import { analyzeUserMetaInfo } from "../tools/user/meta-analyzer";
import { token } from "../config";
import { openai } from "../openai";

export const processMessageController = new Composer<BotContext>();

const analyzer = async (ctx: BotContext) => {
  // Подсчитываем общее количество сообщений пользователя
  const messageCount = await prisma.message.count({
    where: {
      chatId: ctx.chatId,
      senderId: ctx.from!.id,
    },
  });

  // Если это тридцатое сообщение (или кратное 30), анализируем последние 30
  if (messageCount % 30 === 0) {
    const lastMessages = await prisma.message.findMany({
      where: {
        chatId: ctx.chatId,
        senderId: ctx.from!.id,
      },
      orderBy: {
        sentAt: "desc",
      },
      take: 30,
    });

    await analyzeUserMetaInfo(BigInt(ctx.from!.id), lastMessages.reverse());
  }
};

processMessageController.on(":text", async (ctx) => {
  try {
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

      analyzer(ctx);
    }

    if (
      ctx.msg.text.toLowerCase().startsWith("ио") ||
      ctx.msg.reply_to_message?.from?.id === ctx.me.id ||
      ctx.chat.type === "private"
    ) {
      await aiController(ctx);
    }
  } catch (error) {
    logger.error(error);
  }
});

processMessageController.on(":photo", async (ctx) => {
  try {
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
      const media = await Promise.all(
        ctx.msg.photo?.map(async (photo) => {
          const fileLink = await ctx.api.getFile(photo.file_id);

          return `https://api.telegram.org/file/bot${token}/${fileLink.file_path}`;
        }) || []
      );

      // Get image description from OpenAI
      const description = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Опиши что изображено на этой фотографии. Сделай это максимально точно и подробно, так чтобы ты сама могла понять что изображено на фотографии",
              },
              ...media.map((media) => ({
                type: "image_url" as const,
                image_url: { url: media },
              })),
            ],
          },
        ],
        max_tokens: 500,
      });

      const imageDescription = description.choices[0]?.message?.content || "";

      logger.debug(`Image description: ${imageDescription}`);

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
          summary: imageDescription,
        },
      });

      if (
        ctx.msg.text?.toLowerCase().startsWith("ио") ||
        ctx.msg.reply_to_message?.from?.id === ctx.me.id ||
        ctx.chat.type === "private"
      ) {
        await aiController(ctx, imageDescription);
      }
    }

  } catch (error) {
    logger.error(error);
  }
});
