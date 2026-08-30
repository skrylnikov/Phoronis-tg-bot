import { fmt, italic } from '@grammyjs/parse-mode';
import { generateText } from 'ai';
import ffmpeg from 'ffmpeg.js';
import { utilityModel } from '../ai';
import { renderLocalPrompt } from '../ai/local-prompts';
import {
  createRichMessageIfNeeded,
  richMarkdownInstructions,
  toMarkdownV2,
} from '../ai/rich-message';
import type { BotContext } from '../bot';
import {
  releaseQuota,
  reserveQuota,
  saveChat,
  saveMessage,
  saveUser,
} from '../domain';
import { logger } from '../logger';
import {
  findChatByIdRepo,
  findFirstMessageRepo,
  updateMessageFieldsRepo,
} from '../repositories';
import {
  downloadTelegramFile,
  TelegramFileTooLargeError,
} from '../telegram-file';
import { currentUpdateAbortSignal } from '../update-signal.js';
import { yandex } from '../yandex';
import { sendMediaLimitNotice } from './limit-notice';

export const voiceController = async (ctx: BotContext) => {
  let completed = false;
  let reservation: Awaited<ReturnType<typeof reserveQuota>> | null = null;
  try {
    const info = ctx.message?.voice || ctx.message?.video_note;

    const chat = ctx.chat;
    if (!info || !ctx.message || !ctx.chatId || !ctx.from || !chat) {
      return;
    }

    const chatId = ctx.chatId;

    await Promise.all([saveChat(chat), saveUser(ctx.from), saveUser(ctx.me)]);
    const chatSettings = await findChatByIdRepo(BigInt(chatId), {
      privateModeEnabled: true,
    });
    const isPrivateMode = chatSettings?.privateModeEnabled ?? false;
    const existingVoiceMessage = await findFirstMessageRepo(
      {
        chatId,
        id: BigInt(ctx.message.message_id),
      },
      {
        select: { id: true },
      },
    );
    if (existingVoiceMessage) {
      logger.info(
        { event: 'message.duplicate_skipped', messageType: 'VOICE' },
        'Duplicate voice message skipped before recognition',
      );
      return;
    }

    reservation = await reserveQuota({
      userId: ctx.from.id,
      chatId,
      isGroup: chat.type === 'group' || chat.type === 'supergroup',
      kind: 'VOICE',
    });
    if (!reservation.allowed) {
      await sendMediaLimitNotice(ctx, 'VOICE_LIMIT');
      return;
    }

    const { duration, file_id, file_size = 0 } = info;
    await ctx.replyWithChatAction('typing');
    const rawFile = await downloadTelegramFile(ctx, file_id, {
      declaredSize: file_size,
    });

    logger.debug(
      {
        event: 'voice.recognition_started',
        fileSizeKb: Math.round(file_size / 1024),
        durationSeconds: duration,
        videoNote: Boolean(ctx.message.video_note),
      },
      'Voice recognition started',
    );

    let file: Buffer;
    if (ctx.message.video_note) {
      const result = ffmpeg({
        MEMFS: [{ name: 'test.mp4', data: rawFile }],
        arguments: [
          '-i',
          'test.mp4',
          '-vn',
          '-c:a',
          'libopus',
          '-b:a',
          '128k',
          'output.ogg',
        ],
      });
      file = Buffer.from(result.MEMFS[0].data);
    } else {
      file = Buffer.from(rawFile);
    }

    const recognizedResult = await yandex.speechkit.recognize({
      file,
      duration,
    });

    if (!recognizedResult) {
      return;
    }

    logger.debug(
      { event: 'voice.recognition_completed', durationSeconds: duration },
      'Voice recognition completed',
    );

    const result = fmt`${recognizedResult}\n\n${italic}Крашу текст...${italic}`;

    const beautifierPrompt = renderLocalPrompt('text-beautifier', {});
    const summarizePrompt =
      recognizedResult.length > 350
        ? renderLocalPrompt('voice-summarize', {
            author: [
              ctx.from?.username ? `@${ctx.from?.username}` : null,
              ctx.from?.first_name,
              ctx.from?.last_name,
            ]
              .filter(Boolean)
              .join(' '),
          })
        : null;
    const [reply, _savedVoiceMessage] = await Promise.all([
      ctx.reply(result.text, {
        reply_to_message_id: ctx.message.message_id,
        entities: result.entities,
      }),
      saveMessage({
        id: BigInt(ctx.msg?.message_id ?? 0),
        chatId: BigInt(ctx.chatId),
        senderId: BigInt(ctx.from.id),
        sentAt: ctx.msg?.date ? new Date(ctx.msg.date * 1000) : new Date(),
        messageType: 'VOICE',
        text: recognizedResult,
        private: isPrivateMode,
        replyToMessageId: ctx.msg?.reply_to_message?.message_id
          ? BigInt(ctx.msg.reply_to_message.message_id)
          : undefined,
      }),
    ]);

    const voiceMessageId = ctx.msg?.message_id ?? 0;
    const [_savedBotMessage, beautifiedResult, summarizedResult] =
      await Promise.all([
        saveMessage({
          id: BigInt(reply.message_id),
          chatId: BigInt(ctx.chatId),
          senderId: BigInt(reply.from?.id ?? 0),
          sentAt: new Date(reply.date * 1000),
          messageType: 'VOICE',
          text: reply.text,
          private: isPrivateMode,
          replyToMessageId: ctx.message?.message_id
            ? BigInt(ctx.message.message_id)
            : undefined,
        }),
        generateText({
          abortSignal: currentUpdateAbortSignal(),
          model: utilityModel,
          instructions: `${beautifierPrompt}\n${richMarkdownInstructions}`,
          messages: [
            {
              role: 'user',
              content: recognizedResult,
            },
          ],
          temperature: 0,
        }),
        summarizePrompt
          ? generateText({
              abortSignal: currentUpdateAbortSignal(),
              model: utilityModel,
              instructions: `${summarizePrompt}\n${richMarkdownInstructions}`,
              messages: [
                {
                  role: 'user',
                  content: recognizedResult,
                },
              ],
              temperature: 0,
            })
          : null,
      ]);

    const richMarkdown = summarizedResult
      ? `## Краткое содержание\n\n${summarizedResult.text}\n\n<details><summary>Полная расшифровка</summary>\n\n${beautifiedResult.text}\n\n</details>`
      : beautifiedResult.text;
    const updateVoiceMessage = async (): Promise<void> => {
      const richMessage = createRichMessageIfNeeded(richMarkdown);
      if (richMessage) {
        try {
          await ctx.api.editMessageText(chatId, reply.message_id, richMessage);
          return;
        } catch (error) {
          logger.error(
            { event: 'voice.rich_result_update_failed', err: error },
            'Failed to update voice result as rich message',
          );
        }
      }

      try {
        await ctx.api.editMessageText(
          chatId,
          reply.message_id,
          toMarkdownV2(richMarkdown),
          { parse_mode: 'MarkdownV2' },
        );
      } catch (error) {
        logger.error(
          { event: 'voice.markdown_result_update_failed', err: error },
          'Failed to update voice result as MarkdownV2',
        );
        await ctx.api.editMessageText(chatId, reply.message_id, richMarkdown);
      }
    };

    await Promise.all([
      updateVoiceMessage(),
      updateMessageFieldsRepo(BigInt(ctx.chatId), BigInt(voiceMessageId), {
        summary: summarizedResult?.text,
        text: beautifiedResult.text,
      }),
      updateMessageFieldsRepo(BigInt(ctx.chatId), BigInt(reply.message_id), {
        summary: summarizedResult?.text,
        text: beautifiedResult.text,
      }),
    ]);
    completed = true;
  } catch (err) {
    if (err instanceof TelegramFileTooLargeError) {
      await ctx.reply('Не могу обработать файл больше 20 МБ.');
      return;
    }
    logger.error(
      { event: 'voice.processing_failed', err },
      'Voice processing failed',
    );
    throw err;
  } finally {
    if (!completed && reservation) {
      await releaseQuota(reservation).catch((err) =>
        logger.error(
          { event: 'quota.voice_release_failed', err },
          'Failed to release voice quota',
        ),
      );
    }
  }
};
