import type { PhotoSize } from '@grammyjs/types';
import { generateText } from 'ai';
import { Composer } from 'grammy';
import {
  aiController,
  searchContext,
  upsertMessage,
  utilityModel,
} from '../ai';
import { langfuse } from '../ai/langfuse';
import type { BotContext } from '../bot';
import { token } from '../config';
import { prisma } from '../db';
import { logger } from '../logger';
import { canAnalyze, saveChat, saveMessage, saveUser } from '../shared';
import { analyzeUserMetaInfo } from '../tools/user/fact-analyzer';
import { recordUserReaction } from '../tools/user/fact-impact-tracker';
import { handleError } from '../utils/error-handler';

interface Media {
  url: string;
  // buffer: string;
  mimeType: string;
}

interface TelegramReactionResult {
  emoji?: string;
  type?: string;
  count?: number;
}

interface TelegramReactionsMessage {
  reactions?: {
    results?: TelegramReactionResult[];
  };
}

function hasTelegramReactions(msg: unknown): msg is TelegramReactionsMessage {
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  const withReactions = msg as TelegramReactionsMessage;
  return Array.isArray(withReactions.reactions?.results);
}

async function handleUserReaction(
  ctx: BotContext,
  messageText: string,
): Promise<void> {
  if (!ctx.msg?.reply_to_message || !ctx.from || !ctx.chatId) return;
  logger.info('Handling user reaction for message');
  const botMessageId = ctx.msg.reply_to_message.message_id;
  if (!botMessageId) return;

  let telegramReactions: { type: string; count: number }[] | undefined;
  const replyMessage = ctx.msg.reply_to_message;
  if (hasTelegramReactions(replyMessage)) {
    telegramReactions =
      replyMessage.reactions?.results?.map((r) => {
        const type = typeof r.emoji === 'string' ? r.emoji : r.type;
        return {
          type: typeof type === 'string' ? type : '',
          count: typeof r.count === 'number' ? r.count : 0,
        };
      }) ?? [];
  }

  await recordUserReaction(
    botMessageId,
    ctx.from.id,
    ctx.chatId,
    messageText,
    telegramReactions,
  ).catch((error) => logger.error(error, 'Error recording user reaction'));
}

export const processMessageController = new Composer<BotContext>();

const analyzer = async (ctx: BotContext) => {
  if (!ctx.from || !ctx.chatId) {
    return;
  }

  const messageCount = await prisma.message.count({
    where: {
      chatId: ctx.chatId,
      senderId: ctx.from.id,
      private: false,
    },
  });

  if (messageCount % 30 === 0) {
    const userId = BigInt(ctx.from.id);
    const chatId = BigInt(ctx.chatId);

    if (!canAnalyze(userId, chatId)) {
      logger.debug(
        `Analysis limit exceeded for user ${ctx.from.id} in chat ${ctx.chatId}`,
      );
      return;
    }

    const lastMessages = await prisma.message.findMany({
      where: {
        chatId: ctx.chatId,
        senderId: ctx.from.id,
        private: false,
      },
      include: {
        replyToMessage: true,
      },
      orderBy: {
        sentAt: 'desc',
      },
      take: 30,
    });

    await analyzeUserMetaInfo(userId, lastMessages.reverse());
  }
};

processMessageController.on(':text', async (ctx) => {
  try {
    if (!ctx.from || !ctx.chatId) {
      logger.warn('Missing from or chatId in text message');
      return;
    }

    await Promise.all([
      saveChat(ctx.chat),
      saveUser(ctx.from),
      saveUser(ctx.me),
    ]);

    const chat = await prisma.chat.findUnique({
      where: { id: ctx.chatId },
      select: { privateModeEnabled: true },
    });
    const isPrivateMode = chat?.privateModeEnabled ?? false;

    await saveMessage({
      id: ctx.msg.message_id,
      chatId: ctx.chatId,
      senderId: ctx.from.id,
      replyToMessageId: ctx.msg?.reply_to_message?.message_id,
      sentAt: new Date(ctx.msg.date * 1000),
      text: ctx.msg.text,
      messageType: 'TEXT',
      private: isPrivateMode,
    });

    if (!isPrivateMode) {
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

    const { userContext, chatContext, embedding } = await searchContext(
      content,
      ctx.from.id,
      ctx.chatId,
      ctx.chat.type === 'private',
    );

    if (!isPrivateMode && embedding) {
      upsertMessage(
        ctx.msg.message_id,
        embedding,
        content,
        ctx.msg.text,
        ctx.chatId,
        ctx.from.id,
      );
    }

    if (
      ctx.msg.text?.toLowerCase().startsWith('ио') ||
      ctx.msg.reply_to_message?.from?.id === ctx.me.id ||
      ctx.chat.type === 'private'
    ) {
      if (ctx.msg.reply_to_message?.from?.id === ctx.me.id) {
        await handleUserReaction(ctx, ctx.msg.text);
      }

      await aiController(ctx, undefined, userContext, chatContext);
    }
  } catch (error) {
    handleError(error, 'Processing text message');
  }
});

function selectOptimalPhoto(photos: PhotoSize[]): PhotoSize | undefined {
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

processMessageController.on('msg', async (ctx) => {
  try {
    if (!ctx.from || !ctx.chatId) {
      logger.warn('Missing from or chatId in media message');
      return;
    }

    await Promise.all([
      saveChat(ctx.chat),
      saveUser(ctx.from),
      saveUser(ctx.me),
    ]);

    const chat = await prisma.chat.findUnique({
      where: { id: ctx.chatId },
      select: { privateModeEnabled: true },
    });
    const isPrivateMode = chat?.privateModeEnabled ?? false;

    let media: Media[] = [];

    if (ctx.msg.photo) {
      const optimalPhoto = selectOptimalPhoto(ctx.msg.photo);
      if (!optimalPhoto) {
        logger.warn('No optimal photo found');
        return;
      }
      const fileLink = await ctx.api.getFile(optimalPhoto.file_id);
      const url = `https://api.telegram.org/file/bot${token}/${fileLink.file_path}`;
      media = [
        {
          url,
          mimeType: 'image/jpeg',
        },
      ];
    }

    const prompt = await langfuse.getPrompt('image-description');

    const systemPrompt = prompt.compile();

    const response = await generateText({
      model: utilityModel,
      instructions: systemPrompt,
      messages: [
        {
          role: 'user',
          content: media.map((m) => ({
            type: 'image',
            image: new URL(m.url),
          })),
        },
      ],
      temperature: 0,
    });

    const imageDescription = response.text;

    logger.debug(`Image description: ${imageDescription}`);

    await saveMessage({
      id: ctx.msg.message_id,
      chatId: ctx.chatId,
      senderId: ctx.from.id,
      replyToMessageId: ctx.msg?.reply_to_message?.message_id,
      sentAt: new Date(ctx.msg.date * 1000),
      text: ctx.msg.caption,
      messageType: 'MEDIA',
      media: JSON.stringify(media.map((m) => m.url)),
      summary: imageDescription,
      private: isPrivateMode,
    });

    if (
      ctx.msg.text?.toLowerCase().startsWith('ио') ||
      ctx.msg.reply_to_message?.from?.id === ctx.me.id ||
      ctx.chat.type === 'private'
    ) {
      if (ctx.msg.reply_to_message?.from?.id === ctx.me.id) {
        const messageText = ctx.msg.text || ctx.msg.caption || '';
        if (messageText) {
          await handleUserReaction(ctx, messageText);
        }
      }

      await aiController(ctx, imageDescription);
    }
  } catch (error) {
    handleError(error, 'Processing media message');
  }
});
