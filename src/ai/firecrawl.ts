import { currentUpdateAbortSignalWithTimeout } from '../update-signal';

const firecrawlBaseURL = 'https://api.firecrawl.dev/v2';

export interface FirecrawlLimits {
  maxCalls: number;
  maxMarkdownCharacters: number;
  maxSearchResults: number;
  timeoutMs: number;
}

export const firecrawlLimits: FirecrawlLimits = {
  maxCalls: 2,
  maxMarkdownCharacters: 20_000,
  maxSearchResults: 5,
  timeoutMs: 15_000,
} as const;

type FirecrawlErrorCode =
  | 'budget'
  | 'invalid_input'
  | 'malformed_response'
  | 'rate_limit'
  | 'too_large'
  | 'timeout'
  | 'unavailable';

export class FirecrawlError extends Error {
  constructor(readonly code: FirecrawlErrorCode) {
    super(code);
    this.name = 'FirecrawlError';
  }
}

export interface WebPageResult {
  source: string;
  title: string;
  content: string;
}

export interface WebSearchResult {
  url: string;
  title: string;
  description: string;
}

export type FirecrawlFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface FirecrawlClientOptions {
  fetch?: FirecrawlFetcher;
  limits?: Partial<FirecrawlLimits>;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function absoluteWebURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new FirecrawlError('invalid_input');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
  ) {
    throw new FirecrawlError('invalid_input');
  }

  return url.toString();
}

function responseSource(value: unknown, fallback: string): string {
  const candidate = stringValue(value);
  if (!candidate) return fallback;

  try {
    return absoluteWebURL(candidate);
  } catch {
    return fallback;
  }
}

function parseSuccessfulPayload(payload: unknown): JsonRecord {
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    !isRecord(payload.data)
  ) {
    throw new FirecrawlError('malformed_response');
  }
  return payload.data;
}

function parseSearchItem(value: unknown): WebSearchResult | undefined {
  if (!isRecord(value)) return undefined;
  const url = stringValue(value.url);
  if (!url) return undefined;

  try {
    return {
      url: absoluteWebURL(url),
      title: stringValue(value.title) || 'Без названия',
      description: stringValue(value.description) || '',
    };
  } catch {
    return undefined;
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof FirecrawlError) {
    switch (error.code) {
      case 'budget':
        return 'Лимит web-запросов для этого ответа исчерпан';
      case 'invalid_input':
        return 'Нужен абсолютный URL http или https либо непустой поисковый запрос';
      case 'malformed_response':
        return 'Web-сервис вернул некорректный ответ';
      case 'rate_limit':
        return 'Web-сервис временно ограничил количество запросов';
      case 'too_large':
        return 'Содержимое web-страницы слишком большое для обработки';
      case 'timeout':
        return 'Web-запрос превысил лимит времени или был отменён';
      case 'unavailable':
        return 'Web-сервис временно недоступен';
    }
  }

  return 'Не удалось получить данные из интернета';
}

export function createFirecrawlClient(
  apiKey: string,
  options: FirecrawlClientOptions = {},
) {
  const fetcher = options.fetch ?? fetch;
  const limits = { ...firecrawlLimits, ...options.limits };
  let calls = 0;

  async function request(path: 'scrape' | 'search', body: JsonRecord) {
    if (calls >= limits.maxCalls) {
      throw new FirecrawlError('budget');
    }
    calls += 1;

    const signal = currentUpdateAbortSignalWithTimeout(limits.timeoutMs);
    let response: Response;
    try {
      response = await fetcher(`${firecrawlBaseURL}/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw new FirecrawlError('timeout');
      }
      throw new FirecrawlError('unavailable');
    }

    if (!response.ok) {
      throw new FirecrawlError(
        response.status === 429 ? 'rate_limit' : 'unavailable',
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new FirecrawlError('malformed_response');
    }

    return parseSuccessfulPayload(payload);
  }

  return {
    async readWebPage(url: string): Promise<WebPageResult> {
      const source = absoluteWebURL(url);
      const data = await request('scrape', {
        url: source,
        formats: ['markdown'],
        onlyMainContent: true,
      });
      const markdown = stringValue(data.markdown);
      if (!markdown) {
        throw new FirecrawlError('malformed_response');
      }
      if (markdown.length > limits.maxMarkdownCharacters) {
        throw new FirecrawlError('too_large');
      }

      const metadata = isRecord(data.metadata) ? data.metadata : undefined;
      return {
        source: responseSource(metadata?.sourceURL ?? metadata?.url, source),
        title: stringValue(metadata?.title) || 'Без названия',
        content: markdown,
      };
    },

    async searchWeb(query: string, limit: number = limits.maxSearchResults) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery || !Number.isInteger(limit) || limit < 1) {
        throw new FirecrawlError('invalid_input');
      }

      const data = await request('search', {
        query: normalizedQuery,
        limit: Math.min(limit, limits.maxSearchResults),
        sources: ['web'],
      });
      const webResults = Array.isArray(data.web)
        ? data.web
        : Array.isArray(data)
          ? data
          : undefined;
      if (!webResults) {
        throw new FirecrawlError('malformed_response');
      }
      return webResults
        .map(parseSearchItem)
        .filter((result): result is WebSearchResult => Boolean(result))
        .slice(0, limits.maxSearchResults);
    },
  };
}

export { safeErrorMessage };
