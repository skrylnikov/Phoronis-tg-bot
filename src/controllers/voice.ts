import { fmt, italic } from '@grammyjs/parse-mode';
import { generateText } from 'ai';
import ffmpeg from 'ffmpeg.js';
import { langfuse, utilityModel } from '../ai';
import {
  createRichMessageIfNeeded,
  richMarkdownInstructions,
  toMarkdownV2,
} from '../ai/rich-message';
import type { BotContext } from '../bot';
import { token } from '../config.js';

import { prisma } from '../db';
import { logger } from '../logger';
import {
  releaseQuota,
  reserveQuota,
  saveChat,
  saveMessage,
  saveUser,
} from '../domain';
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
    const existingVoiceMessage = await prisma.message.findUnique({
      where: {
        chatId_id: {
          chatId,
          id: ctx.message.message_id,
        },
      },
      select: { id: true },
    });
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
    const fileLink = await ctx.api.getFile(file_id);

    if (!fileLink.file_path) {
      return;
    }

    const response = await fetch(
      `https://api.telegram.org/file/bot${token}/${fileLink.file_path}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.statusText}`);
    }
    const rawFile = await response.arrayBuffer();

    logger.debug(
      {
        event: 'voice.recognition_started',
        fileSizeKb: Math.round(file_size / 1024),
        durationSeconds: duration,
        videoNote: Boolean(ctx.message.video_note),
      },
      'Voice recognition started',
    );
    let file = rawFile;
    if (ctx.message.video_note) {
      const result = ffmpeg({
        MEMFS: [{ name: 'test.mp4', data: new Uint8Array(rawFile) }],
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
    }

    const recognizedResult = await yandex.speechkit.recognize({
      fileId: file_id,
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

    const [reply, beautifierPrompt, summarizePrompt, savedVoiceMessage] =
      await Promise.all([
        ctx.reply(result.text, {
          reply_to_message_id: ctx.message.message_id,
          entities: result.entities,
        }),
        langfuse.getPrompt('text-beautifier'),
        recognizedResult.length > 350
          ? langfuse.getPrompt('voice-summarize')
          : null,
        saveMessage({
          id: ctx.msg?.message_id ?? 0,
          chatId: ctx.chatId,
          senderId: ctx.from.id,
          sentAt: ctx.msg?.date ? new Date(ctx.msg.date * 1000) : new Date(),
          messageType: 'VOICE',
          text: recognizedResult,
          replyToMessageId: ctx.msg?.reply_to_message?.message_id,
        }),
      ]);

    const [savedBotMessage, beautifiedResult, summarizedResult] =
      await Promise.all([
        saveMessage({
          id: reply.message_id,
          chatId: ctx.chatId,
          senderId: reply.from?.id ?? 0,
          sentAt: new Date(reply.date * 1000),
          messageType: 'VOICE',
          text: reply.text,
          replyToMessageId: ctx.message?.message_id,
        }),
        generateText({
          model: utilityModel,
          instructions: `${beautifierPrompt.compile()}\n${richMarkdownInstructions}`,
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
              model: utilityModel,
              instructions: `${summarizePrompt.compile({
                author: [
                  ctx.from?.username ? `@${ctx.from?.username}` : null,
                  ctx.from?.first_name,
                  ctx.from?.last_name,
                ]
                  .filter(Boolean)
                  .join(' '),
              })}\n${richMarkdownInstructions}`,
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
      prisma.message.update({
        where: {
          chatId_id: {
            chatId: savedVoiceMessage.chatId,
            id: savedVoiceMessage.id,
          },
        },
        data: {
          summary: summarizedResult?.text,
          text: beautifiedResult.text,
        },
      }),
      prisma.message.update({
        where: {
          chatId_id: {
            chatId: savedBotMessage.chatId,
            id: savedBotMessage.id,
          },
        },
        data: {
          summary: summarizedResult?.text,
          text: beautifiedResult.text,
        },
      }),
    ]);
    completed = true;
  } catch (err) {
    logger.error(
      { event: 'voice.processing_failed', err },
      'Voice processing failed',
    );
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
