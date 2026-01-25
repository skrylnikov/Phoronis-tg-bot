import { expandableBlockquote, fmt, italic } from '@grammyjs/parse-mode';
import { generateText } from 'ai';
import axios from 'axios';
import ffmpeg from 'ffmpeg.js';
import { langfuse, textBeautifierModel } from '../ai';
import type { BotContext } from '../bot';
import { token } from '../config.js';

import { prisma } from '../db';
import { logger } from '../logger';
import { yandex } from '../yandex';

export const voiceController = async (ctx: BotContext) => {
  try {
    const info = ctx.message?.voice || ctx.message?.video_note;

    if (!info || !ctx.message) {
      return;
    }

    const { duration, file_id, file_size = 0 } = info;
    await ctx.replyWithChatAction('typing');
    const fileLink = await ctx.api.getFile(file_id);

    const rawFile = await axios.get(
      `https://api.telegram.org/file/bot${token}/${fileLink.file_path!}`,
      { responseType: 'arraybuffer' },
    );

    logger.debug(
      `start recognoze voice message from ${JSON.stringify(
        ctx.from,
      )} in ${JSON.stringify(ctx.chat)} ${Math.round(
        file_size / 1024,
      )}Kb ${duration}сек`,
    );
    let file = rawFile.data;
    if (ctx.message.video_note) {
      const result = ffmpeg({
        MEMFS: [{ name: 'test.mp4', data: new Uint8Array(rawFile.data) }],
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

    const [recognizedResult, replyToMessage] = await Promise.all([
      yandex.speechkit.recognize({
        fileId: file_id,
        file,
        duration,
      }),
      prisma.message.findUnique({
        where: {
          chatId_id: {
            chatId: ctx.chatId!,
            id: ctx.msg?.message_id ?? 0,
          },
        },
        select: {
          id: true,
        },
      }),
    ]);

    if (!recognizedResult) {
      return;
    }

    logger.debug(
      `recognize voice result from ${JSON.stringify(
        ctx.from,
      )} in ${JSON.stringify(ctx.chat)} : ${recognizedResult}`,
    );

    let result = fmt`${recognizedResult}\n\n${italic}Крашу текст...${italic}`;

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
        prisma.message.create({
          data: {
            id: ctx.msg!.message_id,
            chatId: ctx.chatId!,
            senderId: ctx.from!.id,
            sentAt: new Date(ctx.msg!.date * 1000),
            messageType: 'VOICE',
            text: recognizedResult,
            replyToMessageId: replyToMessage?.id,
          },
        }),
      ]);

    const [savedBotMessage, beautifiedResult, summarizedResult] =
      await Promise.all([
        prisma.message.create({
          data: {
            id: reply.message_id,
            chatId: ctx.chatId!,
            senderId: reply.from!.id,
            sentAt: new Date(reply.date * 1000),
            messageType: 'VOICE',
            text: reply.text,
            replyToMessageId: ctx.message?.message_id,
          },
        }),
        generateText({
          model: textBeautifierModel,
          messages: [
            {
              role: 'system',
              content: beautifierPrompt.compile(),
            },
            {
              role: 'user',
              content: recognizedResult,
            },
          ],
          temperature: 0,
        }),
        summarizePrompt
          ? generateText({
              model: textBeautifierModel,
              messages: [
                {
                  role: 'system',
                  content: summarizePrompt.compile({
                    author: [
                      ctx.from?.username ? '@' + ctx.from?.username : null,
                      ctx.from?.first_name,
                      ctx.from?.last_name,
                    ]
                      .filter(Boolean)
                      .join(' '),
                  }),
                },
                {
                  role: 'user',
                  content: recognizedResult,
                },
              ],
              temperature: 0,
            })
          : null,
      ]);

    result = summarizedResult
      ? fmt`${summarizedResult.text}

    ${expandableBlockquote}${beautifiedResult.text}${expandableBlockquote}`
      : fmt`${beautifiedResult.text}`;

    await Promise.all([
      ctx.api.editMessageText(ctx.chatId!, reply.message_id, result.text, {
        entities: result.entities,
      }),
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
  } catch (e) {
    logger.error(e);
  }
};
