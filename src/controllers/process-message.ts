import type { PhotoSize } from '@grammyjs/types';
import { generateText } from 'ai';
import { Composer } from 'grammy';
import { aiController, openRouter, searchContext, upsertMessage } from '../ai';
import { langfuse } from '../ai/langfuse';
import type { BotContext } from '../bot';
import { token } from '../config';
import { prisma } from '../db';
import { logger } from '../logger';
import { saveChat, saveMessage, saveUser } from '../shared';
import { analyzeUserMetaInfo } from '../tools/user/fact-analyzer';
import { recordUserReaction } from '../tools/user/fact-impact-tracker';

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
  if (!ctx.msg || !ctx.msg.reply_to_message || !ctx.from || !ctx.chatId) return;
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
  const messageCount = await prisma.message.count({
    where: {
      chatId: ctx.chatId,
      senderId: ctx.from!.id,
    },
  });

  if (messageCount % 30 === 0) {
    const lastMessages = await prisma.message.findMany({
      where: {
        chatId: ctx.chatId,
        senderId: ctx.from!.id,
      },
      include: {
        replyToMessage: true,
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

    await saveMessage({
      id: ctx.msg.message_id,
      chatId: ctx.chatId,
      senderId: ctx.from!.id,
      replyToMessageId: ctx.msg?.reply_to_message?.message_id,
      sentAt: new Date(ctx.msg.date * 1000),
      text: ctx.msg.text,
      messageType: 'TEXT',
    });

    analyzer(ctx);

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
      ctx.from!.id,
      ctx.chatId,
      ctx.chat.type === 'private',
    );

    if (embedding) {
      upsertMessage(
        ctx.msg.message_id,
        embedding,
        content,
        ctx.msg.text,
        ctx.chatId,
        ctx.from!.id,
      );
    }

    if (
      (ctx.msg.text && ctx.msg.text.toLowerCase().startsWith('ио')) ||
      ctx.msg.reply_to_message?.from?.id === ctx.me.id ||
      ctx.chat.type === 'private'
    ) {
      if (ctx.msg.reply_to_message?.from?.id === ctx.me.id) {
        await handleUserReaction(ctx, ctx.msg.text);
      }

      await aiController(ctx, undefined, userContext, chatContext);
    }
  } catch (error) {
    logger.error(error);
  }
});

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

processMessageController.on('msg', async (ctx) => {
  try {
    await Promise.all([
      saveChat(ctx.chat),
      saveUser(ctx.from!),
      saveUser(ctx.me),
    ]);

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

    const response = await generateText({
      model: openRouter('google/gemini-2.5-flash-lite'),
      messages: [
        { role: 'system', content: systemPrompt },
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
      senderId: ctx.from!.id,
      replyToMessageId: ctx.msg?.reply_to_message?.message_id,
      sentAt: new Date(ctx.msg.date * 1000),
      text: ctx.msg.caption,
      messageType: 'MEDIA',
      media: JSON.stringify(media.map((m) => m.url)),
      summary: imageDescription,
    });

    if (
      (ctx.msg.text && ctx.msg.text.toLowerCase().startsWith('ио')) ||
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
    logger.error(error);
  }
});
