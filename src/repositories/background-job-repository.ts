import { prisma } from '../db';
import { analysisErrorCategory } from '../domain/user/analysis-stage';
import {
  BackgroundJobStatus,
  type BackgroundJobType,
  Prisma,
} from '../generated/prisma/client';

export type BackgroundJobPayload = Prisma.InputJsonValue;

export interface ClaimedBackgroundJob {
  id: string;
  type: BackgroundJobType;
  dedupeKey: string;
  payload: BackgroundJobPayload;
  attempts: number;
  externalDeliveryId: string | null;
  createdAt: Date;
  workerId: string;
}

const MAX_BACKOFF_MS = 30 * 60 * 1000;

export function backgroundJobBackoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.max(0, attempts - 1));
}

export async function enqueueBackgroundJobRepo(input: {
  type: BackgroundJobType;
  dedupeKey: string;
  payload: BackgroundJobPayload;
  availableAt?: Date;
  createdAt?: Date;
}): Promise<void> {
  await prisma.backgroundJob.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: {
      type: input.type,
      dedupeKey: input.dedupeKey,
      payload: input.payload,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.availableAt ? { availableAt: input.availableAt } : {}),
    },
    update: {},
  });
}

export async function claimNextBackgroundJobRepo(
  workerId: string,
  leaseDurationMs: number,
): Promise<ClaimedBackgroundJob | undefined> {
  const rows = await prisma.$queryRaw<ClaimedBackgroundJob[]>(Prisma.sql`
    WITH candidate AS (
      SELECT candidate_item."id"
      FROM "BackgroundJob" AS candidate_item
      WHERE (
        (
          candidate_item."status" = 'PENDING'::"BackgroundJobStatus"
          AND candidate_item."availableAt" <= NOW()
        )
        OR (
          candidate_item."status" = 'PROCESSING'::"BackgroundJobStatus"
          AND candidate_item."leaseUntil" < NOW()
        )
      )
      ORDER BY candidate_item."availableAt", candidate_item."createdAt", candidate_item."id"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "BackgroundJob" AS item
    SET "status" = 'PROCESSING'::"BackgroundJobStatus",
        "attempts" = item."attempts" + 1,
        "leaseUntil" = NOW() + ${leaseDurationMs} * INTERVAL '1 millisecond',
        "workerId" = ${workerId},
        "startedAt" = NOW(),
        "lastError" = NULL
    FROM candidate
    WHERE item."id" = candidate."id"
      RETURNING item."id", item."type", item."dedupeKey", item."payload", item."attempts", item."externalDeliveryId", item."createdAt", item."workerId"
  `);
  return rows[0];
}

export async function heartbeatBackgroundJobRepo(
  id: string,
  workerId: string,
  leaseDurationMs: number,
): Promise<boolean> {
  const result = await prisma.backgroundJob.updateMany({
    where: { id, status: BackgroundJobStatus.PROCESSING, workerId },
    data: { leaseUntil: new Date(Date.now() + leaseDurationMs) },
  });
  return result.count === 1;
}

export async function completeBackgroundJobRepo(
  id: string,
  workerId: string,
  externalDeliveryId?: string,
): Promise<boolean> {
  const result = await prisma.backgroundJob.updateMany({
    where: { id, status: BackgroundJobStatus.PROCESSING, workerId },
    data: {
      status: BackgroundJobStatus.COMPLETED,
      completedAt: new Date(),
      leaseUntil: null,
      workerId: null,
      ...(externalDeliveryId === undefined ? {} : { externalDeliveryId }),
    },
  });
  return result.count === 1;
}

export async function failBackgroundJobRepo(input: {
  id: string;
  workerId: string;
  attempts: number;
  maxAttempts: number;
  error: string;
}): Promise<'retry' | 'failed' | 'lost'> {
  const terminal = input.attempts >= input.maxAttempts;
  const result = await prisma.backgroundJob.updateMany({
    where: {
      id: input.id,
      status: BackgroundJobStatus.PROCESSING,
      workerId: input.workerId,
    },
    data: terminal
      ? {
          status: BackgroundJobStatus.FAILED,
          leaseUntil: null,
          workerId: null,
          lastError: input.error,
        }
      : {
          status: BackgroundJobStatus.PENDING,
          availableAt: new Date(
            Date.now() + backgroundJobBackoffMs(input.attempts),
          ),
          leaseUntil: null,
          workerId: null,
          lastError: input.error,
        },
  });
  if (result.count === 0) return 'lost';
  return terminal ? 'failed' : 'retry';
}

export async function releaseBackgroundJobLeaseRepo(
  workerId: string,
): Promise<number> {
  const result = await prisma.backgroundJob.updateMany({
    where: { status: BackgroundJobStatus.PROCESSING, workerId },
    data: {
      status: BackgroundJobStatus.PENDING,
      availableAt: new Date(),
      leaseUntil: null,
      workerId: null,
    },
  });
  return result.count;
}

export async function countBackgroundJobBacklogRepo(): Promise<{
  pending: number;
  processing: number;
  failed: number;
}> {
  const [pending, processing, failed] = await Promise.all([
    prisma.backgroundJob.count({
      where: { status: BackgroundJobStatus.PENDING },
    }),
    prisma.backgroundJob.count({
      where: { status: BackgroundJobStatus.PROCESSING },
    }),
    prisma.backgroundJob.count({
      where: { status: BackgroundJobStatus.FAILED },
    }),
  ]);
  return { pending, processing, failed };
}

export async function freezeAnalysisWindowRepo(
  id: string,
  workerId: string,
  payload: BackgroundJobPayload,
) {
  const result = await prisma.backgroundJob.updateMany({
    where: {
      id,
      workerId,
      type: 'USER_MESSAGE_ANALYSIS',
      status: 'PROCESSING',
      leaseUntil: { gt: new Date() },
    },
    data: { payload },
  });
  if (result.count !== 1) throw new Error('Analysis window lease lost');
}
export async function deferAnalysisJobRepo(
  id: string,
  workerId: string,
  availableAt: Date,
) {
  const result = await prisma.backgroundJob.updateMany({
    where: {
      id,
      workerId,
      type: 'USER_MESSAGE_ANALYSIS',
      status: 'PROCESSING',
    },
    data: {
      status: 'PENDING',
      availableAt,
      attempts: { decrement: 1 },
      workerId: null,
      leaseUntil: null,
      lastError: 'analysis:quota_deferred',
    },
  });
  return result.count === 1;
}

export async function findFailedAnalysisJobsRepo(input: {
  chatId: bigint;
  userId?: bigint;
  from?: Date;
  to?: Date;
  limit: number;
}) {
  return prisma.backgroundJob.findMany({
    where: {
      type: 'USER_MESSAGE_ANALYSIS',
      status: 'FAILED',
      AND: [
        { payload: { path: ['chatId'], equals: String(input.chatId) } },
        ...(input.userId === undefined
          ? []
          : [{ payload: { path: ['userId'], equals: String(input.userId) } }]),
      ],
      createdAt: { gte: input.from, lte: input.to },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: input.limit,
  });
}
export async function replayFailedAnalysisJobRepo(job: {
  id: string;
  payload: unknown;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
}) {
  if (
    !job.payload ||
    typeof job.payload !== 'object' ||
    Array.isArray(job.payload)
  )
    throw new Error('Invalid analysis replay payload');
  const payload = job.payload as Prisma.InputJsonObject;
  const previous = payload.replay;
  const count =
    previous &&
    typeof previous === 'object' &&
    !Array.isArray(previous) &&
    'count' in previous &&
    typeof previous.count === 'number'
      ? previous.count
      : 0;
  const result = await prisma.backgroundJob.updateMany({
    where: {
      id: job.id,
      type: 'USER_MESSAGE_ANALYSIS',
      status: 'FAILED',
      updatedAt: job.updatedAt,
    },
    data: {
      status: 'PENDING',
      attempts: 0,
      workerId: null,
      leaseUntil: null,
      startedAt: null,
      completedAt: null,
      availableAt: new Date(),
      lastError: null,
      payload: {
        ...payload,
        replay: {
          count: count + 1,
          previousAttempts: job.attempts,
          previousErrorCategory: analysisErrorCategory(
            new Error(job.lastError ?? ''),
          ),
          requestedAt: new Date().toISOString(),
        },
      },
    },
  });
  return result.count === 1;
}
