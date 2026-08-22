import type { PhotoSize } from '@grammyjs/types';
import { Composer } from 'grammy';
import {
  aiController,
  queueMessageEmbedding,
  searchAndIndexMessage,
} from '../ai';
import { describeTelegramPhoto } from '../ai/image-description';
import type { BotContext } from '../bot';
import { prisma } from '../db';
import { logger } from '../logger';
import {
  releaseQuota,
  reserveQuota,
  saveChat,
  saveMessageIfAbsent,
  saveUser,
} from '../domain';
import { recordUserReaction } from '../domain/user/fact-impact-tracker';
import { analyzeUserMessages } from '../domain/user/message-analyzer';
import { handleError } from '../utils/error-handler';
import { sendMediaLimitNotice } from './limit-notice';

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

function isGroupChat(ctx: BotContext): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

function hasTelegramReactions(msg: unknown): msg is TelegramReactionsMessage {
  if (!msg || typeof msg !== 'object') return false;
  return Array.isArray((msg as TelegramReactionsMessage).reactions?.results);
}

async function handleUserReaction(
  ctx: BotContext,
  messageText: string,
): Promise<void> {
  if (!ctx.msg?.reply_to_message || !ctx.from || !ctx.chatId) return;
  const botMessageId = ctx.msg.reply_to_message.message_id;
  if (!botMessageId) return;

  const replyMessage = ctx.msg.reply_to_message;
  const telegramReactions = hasTelegramReactions(replyMessage)
    ? (replyMessage.reactions?.results?.map((reaction) => ({
        type:
          typeof reaction.emoji === 'string'
            ? reaction.emoji
            : (reaction.type ?? ''),
        count: reaction.count ?? 0,
      })) ?? [])
    : undefined;

  await recordUserReaction(
    botMessageId,
    ctx.from.id,
    ctx.chatId,
    messageText,
    telegramReactions,
  ).catch((err) =>
    logger.error(
      { event: 'reaction.record_failed', err },
      'Error recording user reaction',
    ),
  );
}

function selectOptimalPhoto(photos: PhotoSize[]): PhotoSize | undefined {
  const maxSize = 896;
  let optimalPhoto = photos[0];
  let optimalSide = 0;
  for (const photo of photos) {
    const side = Math.min(photo.width, photo.height);
    if (side <= maxSize && side > optimalSide) {
      optimalPhoto = photo;
      optimalSide = side;
    }
  }
  return optimalPhoto;
}

async function findPhotoInReplyChain(
  ctx: BotContext,
  startMessage:
    | {
        message_id: number;
        photo?: PhotoSize[];
        reply_to_message?: {
          message_id: number;
          photo?: PhotoSize[];
          reply_to_message?: unknown;
        };
      }
    | null
    | undefined,
  maxDepth = 10,
): Promise<{ photo: PhotoSize; messageId: number } | null> {
  if (!startMessage || !ctx.chatId) return null;

  let currentMessage: typeof startMessage | null = startMessage;
  let depth = 0;

  while (currentMessage && depth < maxDepth) {
    if (currentMessage.photo && currentMessage.photo.length > 0) {
      const photo = selectOptimalPhoto(currentMessage.photo);
      if (photo) {
        return { photo, messageId: currentMessage.message_id };
      }
    }

    const replyTo = currentMessage.reply_to_message;
    if (!replyTo) {
      const dbMessage: {
        media: string | null;
        replyToMessageId: bigint | null;
      } | null = await prisma.message.findUnique({
        where: {
          chatId_id: { chatId: ctx.chatId, id: currentMessage.message_id },
        },
        select: { media: true, replyToMessageId: true },
      });

      if (!dbMessage?.replyToMessageId) break;

      if (dbMessage.media) {
        try {
          const media = JSON.parse(dbMessage.media) as {
            fileId?: string;
            mimeType?: string;
          };
          if (media.fileId && media.mimeType === 'image/jpeg') {
            const file = await ctx.api.getFile(media.fileId);
            if (file.file_path) {
              return {
                photo: { file_id: media.fileId } as PhotoSize,
                messageId: currentMessage.message_id,
              };
            }
          }
        } catch {
          // Skip invalid media
        }
      }

      currentMessage = {
        message_id: Number(dbMessage.replyToMessageId),
        reply_to_message: undefined,
      };
    } else {
      currentMessage = replyTo as typeof startMessage;
    }

    depth += 1;
  }

  return null;
}

export const processMessageController = new Composer<BotContext>();

processMessageController.on(':text', async (ctx) => {
  try {
    if (!ctx.from || !ctx.chatId) return;
    logger.debug(
      { event: 'message.processing_started', messageType: 'TEXT' },
      'Text message processing started',
    );
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
    const savedMessage = await saveMessageIfAbsent({
      id: ctx.msg.message_id,
      chatId: ctx.chatId,
      senderId: ctx.from.id,
      replyToMessageId: ctx.msg.reply_to_message?.message_id,
      sentAt: new Date(ctx.msg.date * 1000),
      text: ctx.msg.text,
      messageType: 'TEXT',
      private: isPrivateMode,
    });
    if (!savedMessage.created) {
      logger.info(
        { event: 'message.duplicate_skipped', messageType: 'TEXT' },
        'Duplicate text message skipped before AI processing',
      );
      return;
    }
    if (!isPrivateMode) {
      void analyzeUserMessages(ctx).catch((error) =>
        logger.error(
          { event: 'user_meta.background_analysis_failed', err: error },
          'Failed to analyze user metadata',
        ),
      );
    }

    const replyText =
      ctx.msg.reply_to_message?.text?.trim() ||
      ctx.msg.reply_to_message?.caption?.trim() ||
      null;
    const messageText = ctx.msg.text.trim();
    const content = replyText
      ? `Q: ${replyText}\n\nA: ${messageText}`
      : messageText;
    const shouldRespond =
      ctx.msg.text.toLowerCase().startsWith('ио') ||
      ctx.msg.reply_to_message?.from?.id === ctx.me.id ||
      ctx.chat.type === 'private';

    if (!shouldRespond) {
      logger.debug(
        { event: 'message.response_skipped', messageType: 'TEXT' },
        'Text message does not require a response',
      );
      if (!isPrivateMode) queueMessageEmbedding();
      return;
    }

    const { userContext, chatContext } = isPrivateMode
      ? { userContext: null, chatContext: null }
      : await searchAndIndexMessage(
          { messageId: ctx.msg.message_id, chatId: ctx.chatId },
          content,
          ctx.from.id,
          ctx.chat.type === 'private',
        );

    if (ctx.msg.reply_to_message?.from?.id === ctx.me.id) {
      await handleUserReaction(ctx, ctx.msg.text);
    }

    let imageDescription: string | undefined;
    const photoInChain = await findPhotoInReplyChain(
      ctx,
      ctx.msg.reply_to_message,
    );
    if (photoInChain) {
      const savedReply = await prisma.message.findUnique({
        where: {
          chatId_id: { chatId: ctx.chatId, id: photoInChain.messageId },
        },
        select: { summary: true },
      });
      imageDescription = savedReply?.summary ?? undefined;
      if (!imageDescription) {
        const reservation = await reserveQuota({
          userId: ctx.from.id,
          chatId: ctx.chatId,
          isGroup: isGroupChat(ctx),
          kind: 'IMAGE',
        });
        if (!reservation.allowed) {
          await sendMediaLimitNotice(ctx, 'IMAGE_LIMIT');
          return;
        }
        try {
          imageDescription = await describeTelegramPhoto(
            ctx,
            photoInChain.photo,
          );
          if (savedReply) {
            await prisma.message.update({
              where: {
                chatId_id: { chatId: ctx.chatId, id: photoInChain.messageId },
              },
              data: { summary: imageDescription },
            });
          }
        } catch (error) {
          await releaseQuota(reservation);
          throw error;
        }
      }
    }

    await aiController(ctx, imageDescription, userContext, chatContext, {
      includeRecentChatContext: !isPrivateMode,
    });
  } catch (error) {
    handleError(error, 'Processing text message');
  }
});

processMessageController.on(':photo', async (ctx) => {
  try {
    if (!ctx.from || !ctx.chatId) return;
    logger.debug(
      { event: 'message.processing_started', messageType: 'MEDIA' },
      'Media message processing started',
    );
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
    const photo = selectOptimalPhoto(ctx.msg.photo);
    if (!photo) return;
    const savedMessage = await saveMessageIfAbsent({
      id: ctx.msg.message_id,
      chatId: ctx.chatId,
      senderId: ctx.from.id,
      replyToMessageId: ctx.msg.reply_to_message?.message_id,
      sentAt: new Date(ctx.msg.date * 1000),
      text: ctx.msg.caption,
      messageType: 'MEDIA',
      media: JSON.stringify({ fileId: photo.file_id, mimeType: 'image/jpeg' }),
      private: isPrivateMode,
    });
    if (!savedMessage.created) {
      logger.info(
        { event: 'message.duplicate_skipped', messageType: 'MEDIA' },
        'Duplicate media message skipped before AI processing',
      );
      return;
    }

    const shouldRespond =
      ctx.msg.caption?.toLowerCase().startsWith('ио') ||
      ctx.msg.reply_to_message?.from?.id === ctx.me.id ||
      ctx.chat.type === 'private';
    if (!shouldRespond) {
      logger.debug(
        { event: 'message.response_skipped', messageType: 'MEDIA' },
        'Media message does not require a response',
      );
      return;
    }

    const reservation = await reserveQuota({
      userId: ctx.from.id,
      chatId: ctx.chatId,
      isGroup: isGroupChat(ctx),
      kind: 'IMAGE',
    });
    if (!reservation.allowed) {
      await sendMediaLimitNotice(ctx, 'IMAGE_LIMIT');
      return;
    }

    let imageDescription: string;
    try {
      imageDescription = await describeTelegramPhoto(ctx, photo);
      await prisma.message.update({
        where: {
          chatId_id: {
            chatId: savedMessage.message.chatId,
            id: savedMessage.message.id,
          },
        },
        data: { summary: imageDescription },
      });
    } catch (error) {
      await releaseQuota(reservation);
      throw error;
    }

    if (ctx.msg.reply_to_message?.from?.id === ctx.me.id && ctx.msg.caption) {
      await handleUserReaction(ctx, ctx.msg.caption);
    }
    await aiController(ctx, imageDescription, undefined, undefined, {
      includeRecentChatContext: !isPrivateMode,
    });
  } catch (error) {
    handleError(error, 'Processing media message');
  }
});
