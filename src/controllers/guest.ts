import type { Message, PhotoSize } from '@grammyjs/types';
import { Composer } from 'grammy';
import { generateGuestResponse } from '../ai/guest-generation';
import { describeTelegramPhoto } from '../ai/image-description';
import { createRichMessageIfNeeded, toMarkdownV2 } from '../ai/rich-message';
import { scheduleUserMessageAnalysis } from '../application/user-message-analysis';
import type { BotContext } from '../bot';
import {
  claimGuestInteraction,
  markGuestInteractionAnswered,
  markGuestInteractionFailed,
  releaseQuota,
  reserveQuota,
  saveChat,
  saveMessage,
  saveUser,
} from '../domain';
import { logger } from '../logger';
import {
  findChatByIdRepo,
  findMessageByIdRepo,
  updateMessageManyRepo,
} from '../repositories';

const guestAnswerId = 'phoronis-guest-answer';
const guestAnswerTitle = 'Ответ Ио';
const guestImageLimitMessage =
  'Лимит анализа изображений на сегодня закончился.';
const maxTextMessageLength = 4096;

export const guestController = new Composer<BotContext>();

export function extractGuestQuery(text: string, botUsername: string): string {
  return text.replace(new RegExp(`@${botUsername}\\b`, 'giu'), '').trim();
}

function getMessageText(message: Message | undefined): string {
  return message?.text?.trim() || message?.caption?.trim() || '';
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

function truncateText(text: string, maxLength: number): string {
  return [...text].slice(0, maxLength).join('');
}

async function answerGuestMessage(ctx: BotContext, markdown: string) {
  const richMessage = createRichMessageIfNeeded(markdown);

  if (richMessage) {
    try {
      return await ctx.answerGuestQuery({
        type: 'article',
        id: guestAnswerId,
        title: guestAnswerTitle,
        input_message_content: { rich_message: richMessage },
      });
    } catch (error) {
      logger.warn(
        { event: 'guest.rich_response_failed', err: error },
        'Failed to send rich guest response',
      );
    }
  }

  return ctx.answerGuestQuery({
    type: 'article',
    id: guestAnswerId,
    title: guestAnswerTitle,
    input_message_content: {
      message_text: truncateText(toMarkdownV2(markdown), maxTextMessageLength),
      parse_mode: 'MarkdownV2',
    },
  });
}

async function persistObservedMessage(
  message: Message,
  chatId: number,
  privateMode: boolean,
  sessionId?: string,
): Promise<boolean> {
  if (!message.from || message.message_id <= 0) return false;

  const existing = await findMessageByIdRepo(
    BigInt(chatId),
    BigInt(message.message_id),
  );
  if (existing) return true;

  await saveUser(message.from);
  try {
    const result = await saveMessage({
      id: BigInt(message.message_id),
      chatId: BigInt(chatId),
      senderId: BigInt(message.from.id),
      sessionId,
      replyToMessageId: message.reply_to_message?.message_id
        ? BigInt(message.reply_to_message.message_id)
        : undefined,
      sentAt: new Date(message.date * 1000),
      text: getMessageText(message) ?? undefined,
      messageType: message.photo ? 'MEDIA' : 'TEXT',
      media: message.photo
        ? JSON.stringify({
            fileId: selectOptimalPhoto(message.photo)?.file_id,
            mimeType: 'image/jpeg',
          })
        : undefined,
      private: privateMode,
    });
    return result.created;
  } catch {
    return false;
  }
}

async function describeGuestPhoto(
  ctx: BotContext,
  message: Message,
): Promise<string | undefined> {
  if (!message.photo) return undefined;
  const photo = selectOptimalPhoto(message.photo);
  if (!photo) return undefined;

  const reservation = await reserveQuota({
    userId: ctx.from?.id ?? 0,
    chatId: ctx.chatId ?? 0,
    isGroup: ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup',
    kind: 'IMAGE',
  });
  if (!reservation.allowed) {
    return guestImageLimitMessage;
  }

  try {
    const description = await describeTelegramPhoto(ctx, photo);
    if (message.message_id > 0 && ctx.chatId) {
      await updateMessageManyRepo(
        {
          chatId: BigInt(ctx.chatId),
          id: BigInt(message.message_id),
        },
        { summary: description },
      );
    }
    return description;
  } catch (error) {
    await releaseQuota(reservation);
    throw error;
  }
}

export async function handleGuestMessage(ctx: BotContext): Promise<void> {
  const message = ctx.guestMessage;
  const botUsername = ctx.me.username;
  const telegramChat = ctx.chat;
  if (
    !message?.guest_query_id ||
    !botUsername ||
    !ctx.from ||
    !ctx.chatId ||
    !telegramChat
  ) {
    return;
  }

  await Promise.all([
    saveChat(telegramChat),
    saveUser(ctx.from),
    saveUser(ctx.me),
  ]);
  const chat = await findChatByIdRepo(BigInt(ctx.chatId), {
    privateModeEnabled: true,
  });
  const privateMode = chat?.privateModeEnabled ?? false;
  const query = extractGuestQuery(getMessageText(message), botUsername);
  const referenceText = getMessageText(message.reply_to_message);
  if (message.reply_to_message) {
    await persistObservedMessage(
      message.reply_to_message,
      ctx.chatId,
      privateMode,
    );
  }
  const messagePersisted = await persistObservedMessage(
    message,
    ctx.chatId,
    privateMode,
    message.guest_query_id,
  );

  const claim = await claimGuestInteraction({
    guestQueryId: message.guest_query_id,
    chatId: BigInt(ctx.chatId),
    userId: BigInt(ctx.from.id),
    messageId: message.message_id > 0 ? BigInt(message.message_id) : undefined,
    query,
    referenceText: referenceText || undefined,
  });
  if (claim.kind !== 'claimed') return;

  if (!privateMode) {
    await scheduleUserMessageAnalysis({
      userId: ctx.from.id,
      chatId: ctx.chatId,
      isGroup: ctx.chat.type === 'group' || ctx.chat.type === 'supergroup',
    });
  }

  try {
    if (!query && !referenceText && !message.photo) {
      const answer =
        'Упомяни меня вместе с вопросом или ответь на сообщение, которое нужно разобрать.';
      await answerGuestMessage(ctx, answer);
      await markGuestInteractionAnswered(claim.id, answer);
      return;
    }

    const imageDescription = await describeGuestPhoto(ctx, message);
    if (imageDescription === guestImageLimitMessage) {
      await answerGuestMessage(ctx, imageDescription);
      await markGuestInteractionAnswered(claim.id, imageDescription);
      return;
    }
    const result = await generateGuestResponse({
      ctx,
      text: query || imageDescription || 'Ответь на сообщение из reference',
      referenceText: referenceText || undefined,
      imageDescription,
      privateMode,
      messagePersisted,
    });
    if (!result) throw new Error('Guest generation returned an empty result');

    await answerGuestMessage(ctx, result);
    await markGuestInteractionAnswered(claim.id, result).catch((error) =>
      logger.error(
        { event: 'guest.interaction_persist_failed', err: error },
        'Failed to persist guest response after delivery',
      ),
    );
  } catch (error) {
    await markGuestInteractionFailed(claim.id, error).catch((markError) =>
      logger.error(
        { event: 'guest.interaction_failure_persist_failed', err: markError },
        'Failed to persist guest failure',
      ),
    );
    throw error;
  }
}

guestController.on('guest_message', async (ctx) => {
  try {
    await handleGuestMessage(ctx);
  } catch (error) {
    logger.error(
      { event: 'guest.processing_failed', err: error },
      'Failed to process guest message',
    );
    try {
      await answerGuestMessage(
        ctx,
        'Не получилось ответить. Попробуй ещё раз.',
      );
    } catch (replyError) {
      logger.error(
        { event: 'guest.error_response_failed', err: replyError },
        'Failed to send guest error response',
      );
      throw error;
    }
  }
});
