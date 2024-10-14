import axios from "axios";
import ffmpeg from "ffmpeg.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { fmt, blockquote } from "@grammyjs/parse-mode";

import {
  token,
  yandexCloudToken,
  yandexS3ID,
  yandexS3Secret,
} from "../config.js";

import { prisma } from "../db";
import { openai } from "../openai";
import { BotContext } from "../bot";

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


interface Check {
  id: string;
  done: boolean;
  response: {
    chunks: unknown[];
  };
}

export const voiceController = async (ctx: BotContext) => {
  try {
    console.log("voiceController");

    const info = ctx.message?.voice || ctx.message?.video_note;

    if (!info || !ctx.message) {
      return;
    }

    const { duration, file_id, file_size = 0 } = info;
    ctx.replyWithChatAction("typing");
    const fileLink = await ctx.api.getFile(file_id);

    const rawFile = await axios.get(
      `https://api.telegram.org/file/bot${token}/${fileLink.file_path!}`,
      { responseType: "arraybuffer" }
    );

    console.log(
      `start recognoze voice message ${Math.round(
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

      console.log(`recognize voice result: ${result.data.result}`);

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
        console.error(result);
        ctx.reply("Не получилось распознать этот войс :(", {
          reply_to_message_id: ctx.message.message_id,
        });
      } else {
        let summary: string | null = null;

        if (text.length > 256) {
          const result = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: "Суммарицируй текст до пары коротких предложений",
              },
              { role: "user", content: text },
            ],
          });

          summary = result.choices[0].message.content;
        }

        await prisma.message.create({
          data: {
            id: ctx.msg!.message_id,
            chatId: ctx.chatId!,
            senderId: ctx.from!.id,
            sentAt: new Date(ctx.msg!.date * 1000),
            messageType: "VOICE",
            text,
            summary,
          },
        });
        console.log(`recognize voice result: ${text}`);

        const quote = blockquote(text);
        quote.entities[0].type = "expandable_blockquote";

        ctx.replyFmt(
          fmt`${summary || ""}

${quote}`,
          { reply_to_message_id: ctx.message.message_id }
        );
      }
    }
  } catch (e) {
    console.error(e);
  }
};
