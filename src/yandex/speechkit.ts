import { S3mini } from 's3mini';
import z from 'zod';

import { yandexCloudToken, yandexS3ID, yandexS3Secret } from '../config';
import { logger } from '../logger';
import { currentUpdateAbortSignal } from '../update-signal';

const s3client = new S3mini({
  accessKeyId: yandexS3ID,
  secretAccessKey: yandexS3Secret,
  endpoint: 'https://storage.yandexcloud.net',
  region: 'us-east-1',
});

const recoginzeSyncSchema = z.object({
  result: z.string(),
});

const recognizeSync = async (file: Buffer, signal?: AbortSignal) => {
  const { result } = await fetch(
    'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize',
    {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${yandexCloudToken}`,
        'x-data-logging-enabled': 'true',
      },
      body: file,
      signal,
    },
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
        }),
      ),
    })
    .optional(),
});

// biome-ignore lint/correctness/noUnusedVariables: test
type Check = z.infer<typeof checkSchema>;

const recognizeAsync = async (
  fileName: string,
  file: Buffer,
  duration: number,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  await s3client.putObject(`bot-voic/phoronis/${fileName}`, file);
  signal?.throwIfAborted();

  const taskResponse = await fetch(
    'https://transcribe.api.cloud.yandex.net/speech/stt/v2/longRunningRecognize',
    {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${yandexCloudToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          specification: {
            languageCode: 'ru-RU',
          },
        },
        audio: {
          uri: `https://storage.yandexcloud.net/bot-voic/phoronis/${fileName}`,
        },
      }),
      signal,
    },
  );

  const task = checkSchema.parse(await taskResponse.json());
  await wait((duration / 60) * 6 * 1000, signal);

  const id = task.id;

  let result = task;
  let counter = 0;
  while (!result.done) {
    const operationResponse = await fetch(
      `https://operation.api.cloud.yandex.net/operations/${id}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Api-Key ${yandexCloudToken}`,
        },
        signal,
      },
    );

    const data = checkSchema.parse(await operationResponse.json());

    result = data;

    await wait(200, signal);
    if (counter++ > 300) {
      break;
    }
  }

  const text =
    result?.response?.chunks
      ?.map(({ alternatives }) => alternatives?.[0]?.text)
      .join('. ') || null;

  return text;
};

interface RecognizeProps {
  fileId: string;
  file: Buffer;
  duration: number;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new Error('Speech recognition aborted'),
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Speech recognition aborted'));
      },
      { once: true },
    );
  });
}

const recognize = async ({ fileId, file, duration }: RecognizeProps) => {
  const signal = currentUpdateAbortSignal();
  try {
    if (file.length < 1024 * 1024 && duration < 30) {
      return await recognizeSync(file, signal);
    } else {
      return await recognizeAsync(fileId, file, duration, signal);
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    logger.error(
      {
        event: 'speech.recognition_failed',
        err,
        fileSize: file.length,
        duration,
      },
      'Speech recognition failed',
    );

    return null;
  }
};

export const speechkit = {
  recognize,
};
