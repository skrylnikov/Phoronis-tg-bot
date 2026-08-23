import { describe, expect, it, vi } from 'vitest';
import type { FirecrawlFetcher } from '../ai/firecrawl';
import {
  createFirecrawlClient,
  FirecrawlError,
  safeErrorMessage,
} from '../ai/firecrawl';
import { withUpdateAbortSignal } from '../update-signal';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Firecrawl client', () => {
  it('scrapes markdown and keeps source metadata compact', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({
          success: true,
          data: {
            markdown: '# Заголовок\n\nТекст',
            metadata: {
              title: 'Страница',
              sourceURL: 'https://example.test/final',
            },
          },
        }),
    );

    const result = await createFirecrawlClient('secret', {
      fetch: fetcher,
    }).readWebPage('https://example.test/page');

    expect(result).toEqual({
      source: 'https://example.test/final',
      title: 'Страница',
      content: '# Заголовок\n\nТекст',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.firecrawl.dev/v2/scrape',
      expect.objectContaining({
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
      }),
    );
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
      url: 'https://example.test/page',
      formats: ['markdown'],
      onlyMainContent: true,
    });
  });

  it('returns bounded search metadata without page content', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({
          success: true,
          data: {
            web: [
              {
                url: 'https://example.test/article',
                title: 'Статья',
                description: 'Краткое описание',
                markdown: 'Не должен попасть в результат',
              },
            ],
          },
        }),
    );

    const result = await createFirecrawlClient('secret', {
      fetch: fetcher,
    }).searchWeb('новости', 3);

    expect(result).toEqual([
      {
        url: 'https://example.test/article',
        title: 'Статья',
        description: 'Краткое описание',
      },
    ]);
  });

  it('rejects malformed and unsuccessful upstream responses safely', async () => {
    for (const response of [
      jsonResponse({ success: true, data: {} }),
      jsonResponse({ success: false, error: 'secret upstream details' }),
      new Response('private body', { status: 500 }),
      new Response('private body', { status: 429 }),
    ]) {
      const fetcher = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) => response,
      );
      const promise = createFirecrawlClient('secret', {
        fetch: fetcher,
      }).searchWeb('запрос');

      await expect(promise).rejects.toBeInstanceOf(FirecrawlError);
      await expect(promise).rejects.not.toThrow('private body');
    }

    expect(safeErrorMessage(new FirecrawlError('rate_limit'))).toBe(
      'Web-сервис временно ограничил количество запросов',
    );
  });

  it('rejects unsupported URLs before making a request', async () => {
    const fetcher = vi.fn() as unknown as FirecrawlFetcher;
    const client = createFirecrawlClient('secret', { fetch: fetcher });

    await expect(
      client.readWebPage('ftp://example.test/file'),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(client.readWebPage('/relative')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      client.readWebPage('https://user:password@example.test'),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('honors update cancellation, content size and call budget limits', async () => {
    const abortedFetcher = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const abortedClient = createFirecrawlClient('secret', {
      fetch: abortedFetcher,
    });
    await withUpdateAbortSignal(AbortSignal.abort(), async () => {
      await expect(abortedClient.searchWeb('запрос')).rejects.toMatchObject({
        code: 'timeout',
      });
    });

    const oversizedClient = createFirecrawlClient('secret', {
      fetch: vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          jsonResponse({
            success: true,
            data: { markdown: '123456', metadata: {} },
          }),
      ),
      limits: { maxMarkdownCharacters: 5 },
    });
    await expect(
      oversizedClient.readWebPage('https://example.test'),
    ).rejects.toMatchObject({
      code: 'too_large',
    });

    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ success: true, data: { web: [] } }),
    );
    const budgetClient = createFirecrawlClient('secret', {
      fetch: fetcher,
      limits: { maxCalls: 1 },
    });
    await budgetClient.searchWeb('первый запрос');
    await expect(budgetClient.searchWeb('второй запрос')).rejects.toMatchObject(
      {
        code: 'budget',
      },
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
