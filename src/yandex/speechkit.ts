import z from "zod";
import { S3mini, sanitizeETag } from "s3mini";

import { yandexCloudToken, yandexS3ID, yandexS3Secret } from "../config";

const s3client = new S3mini({
  accessKeyId: yandexS3ID,
  secretAccessKey: yandexS3Secret,
  endpoint: "https://storage.yandexcloud.net",
  region: "us-east-1",
});

const recoginzeSyncSchema = z.object({
  result: z.string(),
});

const recognizeSync = async (file: Buffer) => {
  const { result } = await fetch(
    "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize",
    {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${yandexCloudToken}`,
        "x-data-logging-enabled": "true",
      },
      body: file,
    }
  )
    .then((res) => res.json())
    .then((res) => recoginzeSyncSchema.parse(res));

  return result;
};

const checkSchema = z.object({
  id: z.string(),
  done: z.boolean(),
  response: z
    .object({
      chunks: z.array(
        z.object({
          alternatives: z.array(z.object({ text: z.string().optional() })),
        })
      ),
    })
    .optional(),
});

type Check = z.infer<typeof checkSchema>;

const recognizeAsync = async (
  fileName: string,
  file: Buffer,
  duration: number
) => {
  await s3client.putObject("bot-voic/phoronis/" + fileName, file);

  const taskResponse = await fetch(
    "https://transcribe.api.cloud.yandex.net/speech/stt/v2/longRunningRecognize",
    {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${yandexCloudToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        config: {
          specification: {
            languageCode: "ru-RU",
          },
        },
        audio: {
          uri: `https://storage.yandexcloud.net/bot-voic/phoronis/${fileName}`,
        },
      }),
    }
  );

  const task = checkSchema.parse(await taskResponse.json());
  await new Promise((res) => setTimeout(res, (duration / 60) * 6 * 1000));

  const id = task.id;

  let result = task;
  let counter = 0;
  while (!result.done) {
    const operationResponse = await fetch(
      `https://operation.api.cloud.yandex.net/operations/${id}`,
      {
        method: "GET",
        headers: {
          Authorization: `Api-Key ${yandexCloudToken}`,
        },
      }
    );

    const data = checkSchema.parse(await operationResponse.json());

    result = data;

    await new Promise((res) => setTimeout(res, 200));
    if (counter++ > 300) {
      break;
    }
  }

  const text =
    result?.response?.chunks
      ?.map(({ alternatives }) => alternatives?.[0]?.text)
      .join(". ") || null;

  return text;
};

interface RecognizeProps {
  fileId: string;
  file: Buffer;
  duration: number;
}

const recognize = async ({ fileId, file, duration }: RecognizeProps) => {
  try {
    if (file.length < 1024 * 1024 && duration < 30) {
      return await recognizeSync(file);
    } else {
      return await recognizeAsync(fileId, file, duration);
    }
  } catch (error) {
    console.error(error);

    return null;
  }
};

export const speechkit = {
  recognize,
};
