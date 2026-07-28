import {
  embeddingBaseURL,
  embeddingModel,
  embeddingTimeoutMs,
} from '../../config';
import { logger } from '../../logger';

const EMBEDDING_DIMENSIONS = 384;
const BACKGROUND_TIMEOUT_MS = 30_000;
const INTERACTIVE_IDLE_POLL_MS = 25;
const BACKGROUND_TEI_BATCH_SIZE = 2;

let interactiveRequests = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function embeddingURL(path: string): URL {
  return new URL(path, `${embeddingBaseURL.replace(/\/$/, '')}/`);
}

function isEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

function parseEmbeddingResponse(value: unknown, expected: number): number[][] {
  const embeddings =
    expected === 1 && isEmbedding(value)
      ? [value]
      : Array.isArray(value) && value.every(isEmbedding)
        ? value
        : null;

  if (!embeddings || embeddings.length !== expected) {
    throw new Error(
      `TEI returned an invalid embedding response; expected ${expected} vectors with ${EMBEDDING_DIMENSIONS} dimensions`,
    );
  }

  return embeddings;
}

async function requestEmbeddings(
  inputs: string[],
  timeoutMs: number,
  mode: 'interactive' | 'background',
): Promise<number[][]> {
  const startedAt = performance.now();
  const response = await fetch(embeddingURL('/embed'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs, normalize: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`TEI request failed with status ${response.status}`);
  }

  const embeddings = parseEmbeddingResponse(
    await response.json(),
    inputs.length,
  );
  logger.info(
    {
      mode,
      model: embeddingModel,
      inputCount: inputs.length,
      durationMs: Math.round(performance.now() - startedAt),
    },
    'Embedding request completed',
  );
  return embeddings;
}

async function withInteractiveRequest<T>(
  operation: () => Promise<T>,
): Promise<T> {
  interactiveRequests += 1;
  try {
    return await operation();
  } finally {
    interactiveRequests -= 1;
  }
}

export async function waitForInteractiveEmbeddings(): Promise<void> {
  while (interactiveRequests > 0) {
    await delay(INTERACTIVE_IDLE_POLL_MS);
  }
}

export async function embedQuery(content: string): Promise<number[]> {
  return withInteractiveRequest(async () => {
    const [embedding] = await requestEmbeddings(
      [`query: ${content}`],
      embeddingTimeoutMs,
      'interactive',
    );
    return embedding;
  });
}

export async function embedQueryAndPassage(
  content: string,
): Promise<{ queryEmbedding: number[]; passageEmbedding: number[] }> {
  return withInteractiveRequest(async () => {
    const [queryEmbedding, passageEmbedding] = await requestEmbeddings(
      [`query: ${content}`, `passage: ${content}`],
      embeddingTimeoutMs,
      'interactive',
    );
    return { queryEmbedding, passageEmbedding };
  });
}

export async function embedPassages(contents: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (
    let index = 0;
    index < contents.length;
    index += BACKGROUND_TEI_BATCH_SIZE
  ) {
    await waitForInteractiveEmbeddings();
    const batch = contents.slice(index, index + BACKGROUND_TEI_BATCH_SIZE);
    embeddings.push(
      ...(await requestEmbeddings(
        batch.map((content) => `passage: ${content}`),
        BACKGROUND_TIMEOUT_MS,
        'background',
      )),
    );
  }
  return embeddings;
}

export async function checkEmbeddingHealth(timeoutMs = 500): Promise<boolean> {
  try {
    const response = await fetch(embeddingURL('/health'), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}
