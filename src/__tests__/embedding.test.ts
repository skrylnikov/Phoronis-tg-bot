import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({
  embeddingBaseURL: 'http://tei:3000',
  embeddingModel: 'intfloat/multilingual-e5-small',
  embeddingTimeoutMs: 20,
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../db', () => ({
  prisma: {},
}));

import { nextEmbeddingBackoff } from '../ai/embedding/backfill';
import {
  embedPassages,
  embedQuery,
  embedQueryAndPassage,
} from '../ai/embedding/client';
import { formatMessageSearchText } from '../ai/embedding/format';

const embedding = Array.from({ length: 384 }, (_, index) => index / 384);

function embeddingResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local embeddings', () => {
  it('batches E5 query and passage prefixes', async () => {
    let body: { inputs?: string[]; normalize?: boolean } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as typeof body;
        return embeddingResponse([embedding, embedding]);
      }),
    );

    const result = await embedQueryAndPassage('Привет');

    expect(body).toEqual({
      inputs: ['query: Привет', 'passage: Привет'],
      normalize: true,
    });
    expect(result.queryEmbedding).toHaveLength(384);
    expect(result.passageEmbedding).toHaveLength(384);
  });

  it('rejects malformed TEI responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => embeddingResponse([[1, 2, 3]])),
    );

    await expect(embedQuery('test')).rejects.toThrow(
      'invalid embedding response',
    );
  });

  it('times out interactive embedding requests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason);
            });
          }),
      ),
    );

    await expect(embedQuery('slow')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('waits for interactive work before starting background work', async () => {
    let finishInteractive: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          if (fetchMock.mock.calls.length === 1) {
            finishInteractive = resolve;
          } else {
            resolve(embeddingResponse([embedding]));
          }
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const interactive = embedQuery('interactive');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const background = embedPassages(['background']);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    finishInteractive?.(embeddingResponse([embedding]));
    await interactive;
    await background;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reconstructs reply-aware message search text', () => {
    expect(formatMessageSearchText('ответ', 'вопрос')).toBe(
      'Q: вопрос\n\nA: ответ',
    );
    expect(formatMessageSearchText(' сообщение ')).toBe('сообщение');
  });

  it('caps exponential backoff', () => {
    expect(nextEmbeddingBackoff(1_000)).toBe(2_000);
    expect(nextEmbeddingBackoff(20_000)).toBe(30_000);
    expect(nextEmbeddingBackoff(30_000)).toBe(30_000);
  });
});
