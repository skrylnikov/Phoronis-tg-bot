import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({
  routerAIToken: 'test-routerai-token',
  token: 'secret-bot-token',
}));
vi.mock('../update-signal.js', () => ({
  currentUpdateAbortSignal: vi.fn(() => undefined),
}));

import { describeTelegramPhoto } from '../ai/image-description';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('image description transport', () => {
  it('sends image bytes to RouterAI without exposing the Telegram token', async () => {
    let providerUrl = '';
    let providerBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('api.telegram.org')) {
          return new Response(new Uint8Array([1, 2, 3]));
        }
        providerUrl = url;
        providerBody = String(init?.body);
        return new Response(
          JSON.stringify({
            id: 'image-test',
            object: 'chat.completion',
            created: 1,
            model: 'test',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Описание' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const ctx = {
      api: { getFile: vi.fn().mockResolvedValue({ file_path: 'photo.jpg' }) },
    } as never;

    await expect(
      describeTelegramPhoto(ctx, {
        file_id: 'photo-1',
        file_unique_id: 'unique-1',
        width: 1,
        height: 1,
        file_size: 3,
      }),
    ).resolves.toBe('Описание');

    expect(providerUrl).not.toContain('secret-bot-token');
    expect(providerBody).not.toContain('secret-bot-token');
    expect(providerBody).toContain('data:image/jpeg;base64,AQID');
  });

  it('does not expose the Telegram token in provider error metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes('api.telegram.org')
          ? new Response(new Uint8Array([1, 2, 3]))
          : new Response(JSON.stringify({ error: { message: 'failed' } }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            }),
      ),
    );
    const ctx = {
      api: { getFile: vi.fn().mockResolvedValue({ file_path: 'photo.jpg' }) },
    } as never;

    let providerError: unknown;
    try {
      await describeTelegramPhoto(ctx, {
        file_id: 'photo-1',
        file_unique_id: 'unique-1',
        width: 1,
        height: 1,
        file_size: 3,
      });
    } catch (error) {
      providerError = error;
    }

    expect(providerError).toBeDefined();
    expect(
      `${String(providerError)} ${JSON.stringify(providerError)}`,
    ).not.toContain('secret-bot-token');
  });
});
