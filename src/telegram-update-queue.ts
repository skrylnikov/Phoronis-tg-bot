import type { Update } from '@grammyjs/types';
import type { Bot } from 'grammy';
import type { BotContext } from './bot';
import type { Prisma } from './generated/prisma/client';
import { logger } from './logger';
import { queueConfig } from './queue-config';
import {
  claimNextTelegramUpdateRepo,
  cleanupTelegramUpdatesRepo,
  enqueueTelegramUpdateRepo,
  heartbeatTelegramUpdateRepo,
  isDuplicatePrismaErrorRepo,
  markTelegramUpdateCompletedRepo,
  markTelegramUpdateFailedRepo,
  releaseTelegramUpdateLeasesRepo,
} from './repositories';
import { withUpdateAbortSignal } from './update-signal';

const cleanupIntervalMs = 6 * 60 * 60 * 1000;
const completedRetentionMs = 7 * 24 * 60 * 60 * 1000;
const failedRetentionMs = 30 * 24 * 60 * 60 * 1000;

type QueueLane = 'NORMAL' | 'URGENT';

interface QueuedUpdate {
  updateId: bigint;
  payload: Update;
  partitionKey: string;
  lane: QueueLane;
  attempts: number;
  receivedAt: Date;
}

export interface EnqueueResult {
  duplicate: boolean;
  lane: QueueLane;
  partitionKey: string;
}

export interface TelegramUpdateRouting {
  lane: QueueLane;
  partitionKey: string;
}

export type TelegramUpdateOutcome =
  | { kind: 'completed' }
  | { kind: 'retryable'; error: unknown }
  | { kind: 'terminal'; error: unknown };

export class TerminalUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalUpdateError';
  }
}

export function mapTelegramUpdateError(error: unknown): TelegramUpdateOutcome {
  return error instanceof TerminalUpdateError
    ? { kind: 'terminal', error }
    : { kind: 'retryable', error };
}

export interface TelegramUpdateQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue(update: Update): Promise<EnqueueResult>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumberAt(value: unknown, path: string[]): number | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return typeof current === 'number' && Number.isSafeInteger(current)
    ? current
    : undefined;
}

function firstNumberAt(value: unknown, paths: string[][]): number | undefined {
  for (const path of paths) {
    const result = readNumberAt(value, path);
    if (result !== undefined) return result;
  }
  return undefined;
}

export function isTelegramUpdate(value: unknown): value is Update {
  const update = asRecord(value);
  return (
    update !== undefined &&
    typeof update.update_id === 'number' &&
    Number.isSafeInteger(update.update_id) &&
    update.update_id >= 0
  );
}

function getUpdateType(update: Update): string {
  return Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';
}

function getChatId(update: Update): number | undefined {
  return firstNumberAt(update, [
    ['message', 'chat', 'id'],
    ['edited_message', 'chat', 'id'],
    ['channel_post', 'chat', 'id'],
    ['edited_channel_post', 'chat', 'id'],
    ['business_message', 'chat', 'id'],
    ['edited_business_message', 'chat', 'id'],
    ['deleted_business_messages', 'chat', 'id'],
    ['guest_message', 'chat', 'id'],
    ['callback_query', 'message', 'chat', 'id'],
    ['my_chat_member', 'chat', 'id'],
    ['chat_member', 'chat', 'id'],
    ['chat_join_request', 'chat', 'id'],
    ['message_reaction', 'chat', 'id'],
    ['message_reaction_count', 'chat', 'id'],
    ['chat_boost', 'chat', 'id'],
    ['removed_chat_boost', 'chat', 'id'],
  ]);
}

function getUserId(update: Update): number | undefined {
  return firstNumberAt(update, [
    ['message', 'from', 'id'],
    ['edited_message', 'from', 'id'],
    ['business_message', 'from', 'id'],
    ['edited_business_message', 'from', 'id'],
    ['guest_message', 'from', 'id'],
    ['callback_query', 'from', 'id'],
    ['inline_query', 'from', 'id'],
    ['chosen_inline_result', 'from', 'id'],
    ['shipping_query', 'from', 'id'],
    ['pre_checkout_query', 'from', 'id'],
    ['purchased_paid_media', 'from', 'id'],
    ['poll_answer', 'user', 'id'],
    ['my_chat_member', 'from', 'id'],
    ['chat_member', 'from', 'id'],
    ['chat_join_request', 'from', 'id'],
    ['business_connection', 'user', 'id'],
    ['subscription', 'from', 'id'],
  ]);
}

function getPartitionKey(update: Update): string {
  const chatId = getChatId(update);
  if (chatId !== undefined) return `chat:${chatId}`;

  const userId = getUserId(update);
  if (userId !== undefined) return `user:${userId}`;

  return 'global';
}

function getLane(update: Update): QueueLane {
  const message = asRecord(update.message);
  const type = getUpdateType(update);
  if (
    type === 'callback_query' ||
    type === 'shipping_query' ||
    type === 'pre_checkout_query' ||
    type === 'successful_payment' ||
    type === 'refunded_payment' ||
    message?.successful_payment !== undefined ||
    message?.refunded_payment !== undefined
  ) {
    return 'URGENT';
  }

  return 'NORMAL';
}

export function classifyTelegramUpdate(update: Update): TelegramUpdateRouting {
  return {
    lane: getLane(update),
    partitionKey: getPartitionKey(update),
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 2000);
  return String(error).slice(0, 2000);
}

function isDuplicateError(error: unknown): boolean {
  return isDuplicatePrismaErrorRepo(error);
}

async function claimNextUpdate(
  lane: QueueLane,
  workerId: string,
): Promise<QueuedUpdate | undefined> {
  const row = await claimNextTelegramUpdateRepo(
    lane,
    workerId,
    queueConfig.leaseDurationMs,
  );
  return row
    ? {
        updateId: row.updateId,
        payload: row.payload,
        partitionKey: row.partitionKey,
        lane: row.lane,
        attempts: row.attempts,
        receivedAt: row.receivedAt,
      }
    : undefined;
}

async function markCompleted(
  update: QueuedUpdate,
  workerId: string,
  startedAt: number,
): Promise<boolean> {
  const result = await markTelegramUpdateCompletedRepo(
    update.updateId,
    workerId,
  );
  if (result === 0) {
    logger.warn(
      {
        event: 'update.lease_lost',
        updateId: Number(update.updateId),
        lane: update.lane,
        partitionKey: update.partitionKey,
        waitMs: Math.max(0, startedAt - update.receivedAt.getTime()),
        processingMs: Math.max(0, Date.now() - startedAt),
      },
      'Telegram update lease was lost before completion',
    );
    return false;
  }
  return true;
}

async function markFailed(
  update: QueuedUpdate,
  workerId: string,
  startedAt: number,
  error: unknown,
  terminal: boolean,
): Promise<void> {
  const message = getErrorMessage(error);
  const result = await markTelegramUpdateFailedRepo(
    update.updateId,
    workerId,
    update.attempts,
    queueConfig.maxAttempts,
    message,
    terminal,
  );
  if (result === 0) {
    logger.warn(
      {
        event: 'update.lease_lost',
        updateId: Number(update.updateId),
        lane: update.lane,
        partitionKey: update.partitionKey,
        waitMs: Math.max(0, startedAt - update.receivedAt.getTime()),
        processingMs: Math.max(0, Date.now() - startedAt),
        err: error,
      },
      'Telegram update lease was lost before failure state could be saved',
    );
    return;
  }

  const waitMs = Math.max(0, startedAt - update.receivedAt.getTime());
  const processingMs = Math.max(0, Date.now() - startedAt);
  if (update.attempts >= queueConfig.maxAttempts) {
    logger.error(
      {
        event: 'update.failed',
        updateId: Number(update.updateId),
        lane: update.lane,
        partitionKey: update.partitionKey,
        attempts: update.attempts,
        waitMs,
        processingMs,
        err: error,
      },
      'Telegram update moved to failed state',
    );
    return;
  }

  const delayMs = Math.min(30 * 60 * 1000, 5000 * 2 ** (update.attempts - 1));
  logger.warn(
    {
      event: 'update.retry',
      updateId: Number(update.updateId),
      lane: update.lane,
      partitionKey: update.partitionKey,
      attempts: update.attempts,
      waitMs,
      processingMs,
      retryInMs: delayMs,
      err: error,
    },
    'Telegram update scheduled for retry',
  );
}

async function cleanupUpdates(): Promise<void> {
  const [completed, failed] = await cleanupTelegramUpdatesRepo(
    completedRetentionMs,
    failedRetentionMs,
  );

  if (completed > 0 || failed > 0) {
    logger.info(
      {
        event: 'update.cleanup_completed',
        completedDeleted: completed,
        failedDeleted: failed,
      },
      'Telegram update inbox cleanup completed',
    );
  }
}

export function createTelegramUpdateQueue(
  bot: Bot<BotContext>,
): TelegramUpdateQueue {
  let stopping = false;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let workers: Promise<void>[] = [];
  const activeControllers = new Set<AbortController>();

  async function processUpdates(lane: QueueLane): Promise<void> {
    const workerId = `${lane.toLowerCase()}-${crypto.randomUUID()}`;
    while (!stopping) {
      let update: QueuedUpdate | undefined;
      try {
        update = await claimNextUpdate(lane, workerId);
      } catch (error) {
        logger.error(
          { event: 'update.worker_claim_failed', lane, err: error },
          'Failed to claim Telegram update',
        );
        await new Promise((resolve) =>
          setTimeout(resolve, queueConfig.pollIntervalMs),
        );
        continue;
      }
      if (!update) {
        await new Promise((resolve) =>
          setTimeout(resolve, queueConfig.pollIntervalMs),
        );
        continue;
      }
      if (stopping) {
        await releaseTelegramUpdateLeasesRepo(workerId);
        break;
      }

      const startedAt = Date.now();
      let leaseLost = false;
      const controller = new AbortController();
      activeControllers.add(controller);
      const heartbeat = setInterval(
        () => {
          void heartbeatTelegramUpdateRepo(
            update?.updateId ?? 0n,
            workerId,
            queueConfig.leaseDurationMs,
          )
            .then((renewed) => {
              if (!renewed) {
                leaseLost = true;
                controller.abort(new Error('Telegram update lease lost'));
              }
            })
            .catch(() => {
              leaseLost = true;
              controller.abort(new Error('Telegram update heartbeat failed'));
            });
        },
        Math.max(1_000, Math.floor(queueConfig.leaseDurationMs / 3)),
      );
      logger.info(
        {
          event: 'update.started',
          updateId: Number(update.updateId),
          updateType: getUpdateType(update.payload),
          lane: update.lane,
          partitionKey: update.partitionKey,
          attempts: update.attempts,
          waitMs: Math.max(0, startedAt - update.receivedAt.getTime()),
        },
        'Telegram update processing started',
      );

      try {
        await withUpdateAbortSignal(controller.signal, () =>
          bot.handleUpdate(update.payload),
        );
        const completed =
          leaseLost || controller.signal.aborted
            ? false
            : await markCompleted(update, workerId, startedAt);
        if (completed) {
          logger.info(
            {
              event: 'update.completed',
              updateId: Number(update.updateId),
              lane: update.lane,
              partitionKey: update.partitionKey,
              waitMs: Math.max(0, startedAt - update.receivedAt.getTime()),
              processingMs: Date.now() - startedAt,
            },
            'Telegram update processing completed',
          );
        }
      } catch (error) {
        if (controller.signal.aborted || leaseLost) {
          logger.warn(
            {
              event: 'update.lease_lost',
              updateId: Number(update.updateId),
              lane: update.lane,
              partitionKey: update.partitionKey,
              err: error,
            },
            'Telegram update stopped after lease loss or shutdown',
          );
        } else {
          const mappedOutcome = mapTelegramUpdateError(error);
          const outcome =
            mappedOutcome.kind === 'completed'
              ? { kind: 'retryable' as const, error }
              : mappedOutcome;
          try {
            await markFailed(
              update,
              workerId,
              startedAt,
              outcome.error,
              outcome.kind === 'terminal',
            );
          } catch (stateError) {
            logger.error(
              {
                event: 'update.state_update_failed',
                updateId: Number(update.updateId),
                lane: update.lane,
                partitionKey: update.partitionKey,
                waitMs: Math.max(0, startedAt - update.receivedAt.getTime()),
                processingMs: Date.now() - startedAt,
                err: stateError,
                originalError: error,
              },
              'Failed to persist Telegram update failure state',
            );
          }
        }
      } finally {
        clearInterval(heartbeat);
        activeControllers.delete(controller);
      }
    }
    await releaseTelegramUpdateLeasesRepo(workerId);
  }

  return {
    async start() {
      stopping = false;
      await bot.init();
      await cleanupUpdates().catch((error) =>
        logger.warn(
          { event: 'update.cleanup_failed', err: error },
          'Telegram update inbox cleanup failed',
        ),
      );
      cleanupTimer = setInterval(() => {
        void cleanupUpdates().catch((error) =>
          logger.warn(
            { event: 'update.cleanup_failed', err: error },
            'Telegram update inbox cleanup failed',
          ),
        );
      }, cleanupIntervalMs);
      workers = [
        processUpdates('URGENT'),
        ...Array.from({ length: queueConfig.normalWorkers }, () =>
          processUpdates('NORMAL'),
        ),
      ];
    },

    async stop() {
      stopping = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      for (const controller of activeControllers) {
        controller.abort(new Error('Telegram update queue is stopping'));
      }
      await Promise.all(workers);
      workers = [];
    },

    async enqueue(update) {
      const { lane, partitionKey } = classifyTelegramUpdate(update);
      try {
        await enqueueTelegramUpdateRepo(
          BigInt(update.update_id),
          update as unknown as Prisma.InputJsonValue,
          partitionKey,
          lane,
        );
        logger.info(
          {
            event: 'update.enqueued',
            updateId: update.update_id,
            updateType: getUpdateType(update),
            lane,
            partitionKey,
          },
          'Telegram update enqueued',
        );
        return { duplicate: false, lane, partitionKey };
      } catch (error) {
        if (isDuplicateError(error)) {
          logger.info(
            {
              event: 'update.duplicate',
              updateId: update.update_id,
              updateType: getUpdateType(update),
              lane,
              partitionKey,
            },
            'Duplicate Telegram update ignored',
          );
          return { duplicate: true, lane, partitionKey };
        }
        throw error;
      }
    },
  };
}
