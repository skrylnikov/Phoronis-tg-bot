import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFile: vi.fn(),
  signal: new AbortController().signal,
}));

vi.mock('../config.js', () => ({ token: 'secret-bot-token' }));
vi.mock('../update-signal.js', () => ({
  currentUpdateAbortSignal: vi.fn(() => mocks.signal),
}));

import {
  downloadTelegramFile,
  TelegramFileTooLargeError,
  telegramFileLimitBytes,
} from '../telegram-file';

function context() {
  return { api: { getFile: mocks.getFile } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getFile.mockResolvedValue({ file_path: 'voice.ogg' });
});

describe('Telegram file download boundary', () => {
  it('rejects a declared file above 20 MiB before downloading', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadTelegramFile(context(), 'file-id', {
        declaredSize: telegramFileLimitBytes + 1,
      }),
    ).rejects.toBeInstanceOf(TelegramFileTooLargeError);

    expect(mocks.getFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels a stream above 20 MiB without assembling a full buffer', async () => {
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: { byteLength: telegramFileLimitBytes },
      })
      .mockResolvedValueOnce({ done: false, value: { byteLength: 1 } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { getReader: () => ({ cancel, read, releaseLock }) },
      }),
    );

    await expect(
      downloadTelegramFile(context(), 'file-id'),
    ).rejects.toBeInstanceOf(TelegramFileTooLargeError);

    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
