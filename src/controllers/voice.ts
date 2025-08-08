import axios from "axios";
import ffmpeg from "ffmpeg.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { fmt, blockquote } from "@grammyjs/parse-mode";
import { logger } from "../logger";

import {
  openRouterToken,
  token,
  yandexCloudToken,
  yandexS3ID,
  yandexS3Secret,
} from "../config.js";

import { prisma } from "../db";
import { BotContext } from "../bot";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { langfuseHandler } from "../ai/langfuse";

interface IResult {
  result: string;
}

const s3 = new S3Client({
  endpoint: "https://storage.yandexcloud.net",
  region: "us-east-1",
  // httpOptions: {
  //   timeout: 10000,
  //   connectTimeout: 10000
  // }
  credentials: {
    accessKeyId: yandexS3ID,
    secretAccessKey: yandexS3Secret,
  },
});

const geminiFlash2 = new ChatOpenAI({
  model: "openai/gpt-5-nano",
  apiKey: openRouterToken,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
  temperature: 0,
});

interface Check {
  id: string;
  done: boolean;
  response: {
    chunks: unknown[];
  };
}

export const voiceController = async (ctx: BotContext) => {
  try {
    const info = ctx.message?.voice || ctx.message?.video_note;

    if (!info || !ctx.message) {
      return;
    }

    const { duration, file_id, file_size = 0 } = info;
    await ctx.replyWithChatAction("typing");
    const fileLink = await ctx.api.getFile(file_id);

    const rawFile = await axios.get(
      `https://api.telegram.org/file/bot${token}/${fileLink.file_path!}`,
      { responseType: "arraybuffer" }
    );

    logger.debug(
      `start recognoze voice message from ${JSON.stringify(
        ctx.from
      )} in ${JSON.stringify(ctx.chat)} ${Math.round(
        file_size / 1024
      )}Kb ${duration}сек`
    );
    let file = rawFile.data;
    if (ctx.message.video_note) {
      const result = ffmpeg({
        MEMFS: [{ name: "test.mp4", data: new Uint8Array(rawFile.data) }],
        arguments: [
          "-i",
          "test.mp4",
          "-vn",
          "-c:a",
          "libopus",
          "-b:a",
          "128k",
          "output.ogg",
        ],
      });
      file = Buffer.from(result.MEMFS[0].data);
    }

    if (file.length < 1024 * 1024 && duration < 30 && !ctx.message.video_note) {
      const result = await axios.post<IResult>(
        "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize",
        file,
        {
          headers: {
            Authorization: `Api-Key ${yandexCloudToken}`,
            "x-data-logging-enabled": "true",
          },
          responseType: "json",
        }
      );

      logger.debug(
        `recognize voice result from ${JSON.stringify(
          ctx.from
        )} in ${JSON.stringify(ctx.chat)} : ${result.data.result}`
      );

      ctx.reply(result.data.result, {
        reply_to_message_id: ctx.message.message_id,
      });
    } else {
      await s3.send(
        new PutObjectCommand({
          Bucket: "bot-voic",
          Key: "phoronis/" + file_id,
          Body: file,
        })
      );

      const task = await axios.post<Check>(
        "https://transcribe.api.cloud.yandex.net/speech/stt/v2/longRunningRecognize",
        {
          config: {
            specification: {
              languageCode: "ru-RU",
            },
          },
          audio: {
            uri: `https://storage.yandexcloud.net/bot-voic/phoronis/${file_id}`,
          },
        },
        {
          headers: {
            Authorization: `Api-Key ${yandexCloudToken}`,
          },
          responseType: "json",
        }
      );
      await new Promise((res) => setTimeout(res, (duration / 60) * 10 * 1000));

      const id = task.data.id;

      let result = task.data;
      let counter = 0;
      while (!result.done) {
        const { data } = await axios.get<Check>(
          `https://operation.api.cloud.yandex.net/operations/${id}`,
          {
            headers: {
              Authorization: `Api-Key ${yandexCloudToken}`,
            },
            responseType: "json",
          }
        );

        result = data;

        await new Promise((res) => setTimeout(res, 200));
        if (counter++ > 300) {
          break;
        }
      }

      const text = result?.response?.chunks
        ?.map(({ alternatives }: any) => alternatives?.[0]?.text)
        .join(". ");

      if (!text) {
        logger.error(result);
        ctx.reply("Не получилось распознать этот войс :(", {
          reply_to_message_id: ctx.message.message_id,
        });
      } else {
        let summary: string | null = null;

        if (text.length > 256) {
          const result = await geminiFlash2.invoke(
            [
              new SystemMessage(
                "Суммарицируй текст до пары коротких предложений"
              ),
              new HumanMessage(text),
            ],
            {
              callbacks: [langfuseHandler],
            }
          );
          // const result = await openai.chat.completions.create({
          //   model: "gpt-4o-mini",
          //   messages: [
          //     {
          //       role: "system",
          //       content: "Суммарицируй текст до пары коротких предложений",
          //     },
          //     { role: "user", content: text },
          //   ],
          // });

          if (typeof result.content === "string") {
            summary = result.content;
          } else {
            // @ts-ignore
            summary = result.content[result.content.length - 1].type === "text" ? result.content[result.content.length - 1].text : null;
          }
        }

        const replyToMessage = await prisma.message.findUnique({
          where: {
            chatId_id: {
              chatId: ctx.chatId!,
              id: ctx.msg?.message_id!,
            },
          },
          select: {
            id: true,
          },
        });

        await prisma.message.create({
          data: {
            id: ctx.msg!.message_id,
            chatId: ctx.chatId!,
            senderId: ctx.from!.id,
            sentAt: new Date(ctx.msg!.date * 1000),
            messageType: "VOICE",
            text,
            summary,
            replyToMessageId: replyToMessage?.id,
          },
        });
        logger.debug(`recognize voice result: ${text}`);

        const quote = blockquote(text);
        quote.entities[0].type = "expandable_blockquote";

        const reply = await ctx.replyFmt(
          fmt`${summary || ""}

${quote}`,
          { reply_to_message_id: ctx.message.message_id }
        );

        await prisma.message.create({
          data: {
            id: reply.message_id,
            chatId: ctx.chatId!,
            senderId: reply.from!.id,
            sentAt: new Date(reply.date * 1000),
            messageType: "VOICE",
            text,
            summary,
            replyToMessageId: ctx.message.message_id,
          },
        });
      }
    }
  } catch (e) {
    logger.error(e);
  }
};
