import type { BotContext } from './bot';
import { token } from './config.js';
import { currentUpdateAbortSignal } from './update-signal.js';

export const telegramFileLimitBytes = 20 * 1024 * 1024;

export class TelegramFileTooLargeError extends Error {
  constructor() {
    super('Telegram file exceeds the supported size limit');
    this.name = 'TelegramFileTooLargeError';
  }
}

export async function downloadTelegramFile(
  ctx: BotContext,
  fileId: string,
  options: {
    declaredSize?: number;
    maxBytes?: number;
  } = {},
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? telegramFileLimitBytes;
  if (options.declaredSize !== undefined && options.declaredSize > maxBytes) {
    throw new TelegramFileTooLargeError();
  }

  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram did not return file path');
  const response = await fetch(
    `https://api.telegram.org/file/bot${token}/${file.file_path}`,
    { signal: currentUpdateAbortSignal() },
  );
  if (!response.ok) {
    throw new Error(
      `Telegram file download failed with status ${response.status}`,
    );
  }
  if (!response.body) throw new Error('Telegram file response has no body');

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TelegramFileTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
