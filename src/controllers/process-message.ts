import { Composer } from "grammy";
import { logger } from "../logger";

import { saveChat, saveUser } from "../shared";
import { prisma } from "../db";
import { BotContext } from "../bot";
import { aiController } from "../ai";
import { analyzeUserMetaInfo } from "../tools/user/meta-analyzer";
import { token } from "../config";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { langfuse, langfuseHandler } from "../ai/langfuse";
import axios from "axios";
import { Buffer } from "buffer";

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

async function downloadImage(url: string): Promise<Buffer> {
  console.log("downloadImage", url);
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(response.data);
}

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
          const url = `https://api.telegram.org/file/bot${token}/${fileLink.file_path}`;
          const imageBuffer = await downloadImage(url);
          return {
            url,
            buffer: imageBuffer.toString("base64"),
            mimeType: "image/jpeg",
          };
        }) || []
      );

      const gemma3 = new ChatOpenAI({
        model: "gemma-3-12b-it@q3_k_l",
        configuration: {
          baseURL: "http://lamas-station:1234/v1",
        },
      });

      const prompt = await langfuse.getPrompt("image-description");

      const systemPrompt = prompt.compile();

      const response = await gemma3.invoke(
        [
          new SystemMessage(systemPrompt),
          new HumanMessage({
            content: media.map((m) => ({
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64," + m.buffer },
            })),
          }),
        ],
        {
          callbacks: [langfuseHandler],
        }
      );

      const imageDescription =
        typeof response.content === "string"
          ? response.content
          : Array.isArray(response.content)
          ? response.content
              .map((c) => (typeof c === "string" ? c : ""))
              .join("")
          : "";

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
          media: JSON.stringify(media.map((m) => m.url)),
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
