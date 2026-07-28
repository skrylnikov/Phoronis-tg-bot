import { embeddingVersion } from '../../config';
import { prisma } from '../../db';
import { logger } from '../../logger';
import { checkEmbeddingHealth, embedPassages } from './client';
import { formatMessageSearchText } from './format';
import {
  markMessageEmbeddingSkipped,
  updateFactEmbedding,
  updateMemoryEmbedding,
  updateMessageEmbedding,
} from './store';

const BATCH_SIZE = 16;
const BATCH_INTERVAL_MS = 3_000;
const BACKLOG_REFRESH_INTERVAL_MS = 60_000;
const IDLE_INTERVAL_MS = 30_000;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

type BackfillEntity = 'Message' | 'Memory' | 'UserFact';
type Backlog = {
  messages: number;
  memories: number;
  facts: number;
};

let workerPromise: Promise<void> | null = null;
let stopped = false;
let wakeWorker: (() => void) | null = null;

function outdatedEmbeddingWhere() {
  return {
    OR: [
      { embeddingVersion: null },
      { embeddingVersion: { not: embeddingVersion } },
    ],
  };
}

export function nextEmbeddingBackoff(currentMs: number): number {
  return Math.min(currentMs * 2, MAX_RETRY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeWorker = null;
      resolve();
    }, ms);
    wakeWorker = () => {
      clearTimeout(timer);
      wakeWorker = null;
      resolve();
    };
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backfillMessages(): Promise<number> {
  const messages = await prisma.message.findMany({
    where: {
      AND: [
        outdatedEmbeddingWhere(),
        { OR: [{ private: false }, { private: null }] },
      ],
    },
    include: {
      replyToMessage: {
        select: { text: true, summary: true },
      },
    },
    orderBy: [{ sentAt: 'asc' }, { chatId: 'asc' }, { id: 'asc' }],
    take: BATCH_SIZE,
  });

  const embeddable = messages
    .map((message) => ({
      message,
      content: formatMessageSearchText(
        message.summary || message.text,
        message.replyToMessage?.summary || message.replyToMessage?.text,
      ),
    }))
    .filter(({ content }) => content.length > 0);

  for (const message of messages.filter(
    (message) =>
      !embeddable.some(
        (item) =>
          item.message.chatId === message.chatId &&
          item.message.id === message.id,
      ),
  )) {
    await markMessageEmbeddingSkipped(message.chatId, message.id);
  }

  if (embeddable.length > 0) {
    const embeddings = await embedPassages(
      embeddable.map(({ content }) => content),
    );
    for (const [index, { message, content }] of embeddable.entries()) {
      await updateMessageEmbedding(
        message.chatId,
        message.id,
        content,
        embeddings[index],
      );
    }
  }

  return messages.length;
}

async function backfillMemories(): Promise<number> {
  const memories = await prisma.memory.findMany({
    where: outdatedEmbeddingWhere(),
    orderBy: { id: 'asc' },
    take: BATCH_SIZE,
  });
  if (memories.length === 0) return 0;

  const embeddings = await embedPassages(
    memories.map((memory) => memory.content),
  );
  for (const [index, memory] of memories.entries()) {
    await updateMemoryEmbedding(memory.id, embeddings[index]);
  }
  return memories.length;
}

async function backfillFacts(): Promise<number> {
  const facts = await prisma.userFact.findMany({
    where: outdatedEmbeddingWhere(),
    orderBy: { id: 'asc' },
    take: BATCH_SIZE,
  });
  if (facts.length === 0) return 0;

  const embeddings = await embedPassages(facts.map((fact) => fact.content));
  for (const [index, fact] of facts.entries()) {
    await updateFactEmbedding(fact.id, embeddings[index]);
  }
  return facts.length;
}

async function getBacklog(): Promise<Backlog> {
  const [messages, memories, facts] = await Promise.all([
    prisma.message.count({
      where: {
        AND: [
          outdatedEmbeddingWhere(),
          { OR: [{ private: false }, { private: null }] },
        ],
      },
    }),
    prisma.memory.count({ where: outdatedEmbeddingWhere() }),
    prisma.userFact.count({ where: outdatedEmbeddingWhere() }),
  ]);
  return { messages, memories, facts };
}

async function runWorker(): Promise<void> {
  let retryMs = INITIAL_RETRY_MS;
  let processed = 0;
  const processedByType: Record<BackfillEntity, number> = {
    Message: 0,
    Memory: 0,
    UserFact: 0,
  };
  let activeEntity: BackfillEntity | 'health' = 'health';
  let backlog: Backlog | null = null;
  let backlogMeasuredAt = 0;
  const startedAt = Date.now();

  while (!stopped) {
    try {
      activeEntity = 'health';
      if (!(await checkEmbeddingHealth(2_000))) {
        throw new Error('TEI health check failed');
      }

      activeEntity = 'Message';
      const messageCount = await backfillMessages();
      let memoryCount = 0;
      let factCount = 0;
      if (messageCount === 0) {
        activeEntity = 'Memory';
        memoryCount = await backfillMemories();
      }
      if (messageCount === 0 && memoryCount === 0) {
        activeEntity = 'UserFact';
        factCount = await backfillFacts();
      }
      const batchProcessed = messageCount + memoryCount + factCount;

      retryMs = INITIAL_RETRY_MS;
      if (batchProcessed === 0) {
        logger.info(
          {
            backlog: { messages: 0, memories: 0, facts: 0 },
            processedByType,
          },
          'Embedding backfill is caught up',
        );
        await sleep(IDLE_INTERVAL_MS);
        continue;
      }

      const entity: BackfillEntity =
        messageCount > 0 ? 'Message' : memoryCount > 0 ? 'Memory' : 'UserFact';
      processedByType[entity] += batchProcessed;
      processed += batchProcessed;
      const now = Date.now();
      let backlogExact = false;
      let currentBacklog: Backlog;
      if (
        backlog === null ||
        now - backlogMeasuredAt >= BACKLOG_REFRESH_INTERVAL_MS
      ) {
        backlogExact = true;
        currentBacklog = await getBacklog();
        backlog = currentBacklog;
        backlogMeasuredAt = Date.now();
      } else {
        const backlogKey =
          entity === 'Message'
            ? 'messages'
            : entity === 'Memory'
              ? 'memories'
              : 'facts';
        currentBacklog = {
          ...backlog,
          [backlogKey]: Math.max(0, backlog[backlogKey] - batchProcessed),
        };
        backlog = currentBacklog;
      }
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 1);
      const ratePerSecond = processed / elapsedSeconds;
      const remaining =
        currentBacklog.messages +
        currentBacklog.memories +
        currentBacklog.facts;
      logger.info(
        {
          entity,
          batchProcessed,
          processed,
          processedByType,
          backlog: currentBacklog,
          backlogExact,
          ratePerSecond: Number(ratePerSecond.toFixed(2)),
          etaSeconds:
            ratePerSecond > 0 ? Math.ceil(remaining / ratePerSecond) : null,
        },
        'Embedding backfill batch completed',
      );
      await delay(BATCH_INTERVAL_MS);
    } catch (error) {
      logger.warn(
        {
          err: error,
          entity: activeEntity,
          failedRecords: activeEntity === 'health' ? 0 : 1,
          retryMs,
        },
        'Embedding backfill failed; retrying',
      );
      await sleep(retryMs);
      retryMs = nextEmbeddingBackoff(retryMs);
    }
  }
}

export function requestEmbeddingBackfill(): void {
  wakeWorker?.();
}

export function startEmbeddingBackfill(): void {
  if (workerPromise) return;
  stopped = false;
  workerPromise = runWorker().finally(() => {
    workerPromise = null;
  });
  logger.info({ embeddingVersion }, 'Embedding backfill worker started');
}

export async function stopEmbeddingBackfill(): Promise<void> {
  stopped = true;
  wakeWorker?.();
  await workerPromise;
  logger.info('Embedding backfill worker stopped');
}
