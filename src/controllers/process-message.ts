import type { PhotoSize } from '@grammyjs/types';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { embed } from 'ai';
import axios from 'axios';
import { Buffer } from 'buffer';
import { Composer } from 'grammy';
import { aiController, openRouter } from '../ai';
import { langfuse, langfuseHandler } from '../ai/langfuse';
import type { BotContext } from '../bot';
import { openRouterToken, token } from '../config';
import { prisma } from '../db';
import { logger } from '../logger';
import { qdrantClient } from '../qdrant';
import { saveChat, saveUser } from '../shared';
import { analyzeUserMetaInfo } from '../tools/user/meta-analyzer';

interface Media {
  url: string;
  // buffer: string;
  mimeType: string;
}

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
        sentAt: 'desc',
      },
      take: 30,
    });

    await analyzeUserMetaInfo(BigInt(ctx.from!.id), lastMessages.reverse());
  }
};

processMessageController.on(':text', async (ctx) => {
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

    if (chat?.greeting || ctx.chat.type === 'private') {
      const replyToMessage = ctx.msg?.reply_to_message?.message_id
        ? await prisma.message.findUnique({
            where: {
              chatId_id: {
                chatId: ctx.chatId,
                id: ctx.msg?.reply_to_message?.message_id,
              },
            },
            select: {
              id: true,
            },
          })
        : null;

      await prisma.message.create({
        data: {
          id: ctx.msg.message_id,
          chatId: ctx.chatId,
          senderId: ctx.from!.id,
          replyToMessageId: replyToMessage?.id,
          sentAt: new Date(ctx.msg.date * 1000),
          text: ctx.msg.text,
          messageType: 'TEXT',
        },
      });

      analyzer(ctx);
    }

    const replyToMessageText =
      ctx.msg.reply_to_message?.text?.trim() ||
      ctx.msg.reply_to_message?.caption?.trim() ||
      null;

    const messageText = (ctx.msg.text || ctx.msg.caption || '').trim();

    const content = replyToMessageText
      ? `Q: ${replyToMessageText} \n\n A: ${messageText}`
      : messageText;

    let userContext: string[] | null = null;

    if (content.length > 10) {
      const result = await embed({
        model: openRouter.textEmbeddingModel('qwen/qwen3-embedding-8b'),
        value: content,
        providerOptions: {
          llamaGate: {
            dimensions: 4096,
          },
        },
      });

      const searchResult = await qdrantClient.search('messages', {
        vector: result.embedding,
        filter: {
          must: [
            {
              key: 'userId',
              match: {
                value: ctx.from!.id,
              },
            },
          ],
        },
        score_threshold: 0.6,
        limit: 5,
        with_payload: true,
      });

      if (searchResult.length > 0) {
        userContext = searchResult.map((x) => x.payload!.content as string);
      }

      qdrantClient
        .upsert('messages', {
          points: [
            {
              id: ctx.msg.message_id,
              vector: result.embedding,
              payload: {
                content,
                text: ctx.msg.text,
                chatId: ctx.chatId,
                userId: ctx.from!.id,
              },
            },
          ],
        })
        .catch((error) => logger.error(error));
    }

    // const randomAnswer = ctx.msg.text.endsWith("?") && Math.random() < 0.3;

    if (
      ctx.msg.text.toLowerCase().startsWith('ио') ||
      ctx.msg.reply_to_message?.from?.id === ctx.me.id ||
      ctx.chat.type === 'private'
    ) {
      await aiController(ctx, undefined, userContext);
    }
  } catch (error) {
    logger.error(error);
  }
});

async function downloadImage(url: string): Promise<Buffer> {
  console.log('downloadImage', url);
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

function selectOptimalPhoto(photos: PhotoSize[]): any {
  const MAX_SIZE = 896;
  let optimalPhoto = photos[0];
  let maxSize = 0;

  for (const photo of photos) {
    const size = Math.min(photo.width, photo.height);
    if (size <= MAX_SIZE && size > maxSize) {
      maxSize = size;
      optimalPhoto = photo;
    }
  }

  return optimalPhoto;
}

const geminiFlash2 = new ChatOpenAI({
  model: 'google/gemini-2.5-flash-lite',
  apiKey: openRouterToken,
  configuration: {
    baseURL: 'https://openrouter.ai/api/v1',
  },
  temperature: 0,
});

processMessageController.on('msg', async (ctx) => {
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

    if (chat?.greeting || ctx.chat.type === 'private') {
      let media: Media[] = [];

      if (ctx.msg.photo) {
        const optimalPhoto = selectOptimalPhoto(ctx.msg.photo);
        const fileLink = await ctx.api.getFile(optimalPhoto.file_id);
        const url = `https://api.telegram.org/file/bot${token}/${fileLink.file_path}`;
        // const imageBuffer = await downloadImage(url);
        media = [
          {
            url,
            // buffer: imageBuffer.toString("base64"),
            mimeType: 'image/jpeg',
          },
        ];
      }

      const prompt = await langfuse.getPrompt('image-description');

      const systemPrompt = prompt.compile();

      const response = await geminiFlash2.invoke(
        [
          new SystemMessage(systemPrompt),
          new HumanMessage({
            content: media.map((m) => ({
              type: 'image_url',
              image_url: { url: m.url },
            })),
          }),
        ],
        {
          callbacks: [langfuseHandler],
        },
      );

      const imageDescription =
        typeof response.content === 'string'
          ? response.content
          : Array.isArray(response.content)
            ? response.content
                .map((c) => (typeof c === 'string' ? c : ''))
                .join('')
            : '';

      logger.debug(`Image description: ${imageDescription}`);

      const replyToMessage = await prisma.message.findUnique({
        where: {
          chatId_id: {
            chatId: ctx.chatId!,
            id: ctx.msg?.message_id ?? 0,
          },
        },
        select: {
          id: true,
        },
      });

      await prisma.message.create({
        data: {
          id: ctx.msg.message_id,
          chatId: ctx.chatId,
          senderId: ctx.from!.id,
          replyToMessageId: replyToMessage?.id,
          sentAt: new Date(ctx.msg.date * 1000),
          text: ctx.msg.caption,
          messageType: 'MEDIA',
          media: JSON.stringify(media.map((m) => m.url)),
          summary: imageDescription,
        },
      });

      if (
        ctx.msg.text?.toLowerCase().startsWith('ио') ||
        ctx.msg.reply_to_message?.from?.id === ctx.me.id ||
        ctx.chat.type === 'private'
      ) {
        await aiController(ctx, imageDescription);
      }
    }
  } catch (error) {
    logger.error(error);
  }
});
