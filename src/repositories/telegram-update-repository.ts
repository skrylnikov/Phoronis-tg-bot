import type { Update } from '@grammyjs/types';
import { prisma } from '../db';
import { Prisma } from '../generated/prisma/client';

export async function claimNextTelegramUpdateRepo(
  lane: string,
  workerId: string,
  leaseDurationMs: number,
): Promise<{
  updateId: bigint;
  payload: Update;
  partitionKey: string;
  lane: string;
  attempts: number;
  receivedAt: Date;
} | undefined> {
  const rows = await prisma.$queryRaw<
    Array<{
      updateId: bigint;
      payload: Update;
      partitionKey: string;
      lane: string;
      attempts: number;
      receivedAt: Date;
    }>
  >(Prisma.sql`
    WITH candidate AS (
      SELECT candidate_item."updateId"
      FROM "TelegramUpdate" AS candidate_item
      WHERE candidate_item."lane" = ${lane}::"TelegramUpdateLane"
        AND (
          (
            candidate_item."status" = 'PENDING'::"TelegramUpdateStatus"
            AND candidate_item."availableAt" <= NOW()
          )
          OR (
            candidate_item."status" = 'PROCESSING'::"TelegramUpdateStatus"
            AND candidate_item."leaseUntil" < NOW()
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "TelegramUpdate" AS older
          WHERE older."partitionKey" = candidate_item."partitionKey"
            AND older."lane" = candidate_item."lane"
            AND older."updateId" < candidate_item."updateId"
            AND older."status" IN (
              'PENDING'::"TelegramUpdateStatus",
              'PROCESSING'::"TelegramUpdateStatus"
            )
        )
      ORDER BY candidate_item."updateId"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "TelegramUpdate" AS item
    SET "status" = 'PROCESSING'::"TelegramUpdateStatus",
        "attempts" = item."attempts" + 1,
        "leaseUntil" = NOW() + ${leaseDurationMs} * INTERVAL '1 millisecond',
        "workerId" = ${workerId},
        "startedAt" = NOW(),
        "lastError" = NULL
    FROM candidate
    WHERE item."updateId" = candidate."updateId"
    RETURNING item."updateId", item."payload", item."partitionKey", item."lane", item."attempts", item."receivedAt"
  `);

  return rows[0];
}

export async function markTelegramUpdateCompletedRepo(
  updateId: bigint,
  workerId: string,
): Promise<number> {
  const result = await prisma.telegramUpdate.updateMany({
    where: {
      updateId,
      status: 'PROCESSING',
      workerId,
    },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      leaseUntil: null,
      workerId: null,
    },
  });
  return result.count;
}

export async function markTelegramUpdateFailedRepo(
  updateId: bigint,
  workerId: string,
  attempts: number,
  maxAttempts: number,
  lastError: string,
): Promise<number> {
  const data = {
    leaseUntil: null,
    workerId: null,
    lastError,
  };
  const result = await prisma.telegramUpdate.updateMany({
    where: {
      updateId,
      status: 'PROCESSING',
      workerId,
    },
    data:
      attempts >= maxAttempts
        ? { ...data, status: 'FAILED' as const }
        : {
            ...data,
            status: 'PENDING' as const,
            availableAt: new Date(
              Date.now() + Math.min(30 * 60 * 1000, 5000 * 2 ** (attempts - 1)),
            ),
          },
  });
  return result.count;
}

export async function cleanupTelegramUpdatesRepo(
  completedRetentionMs: number,
  failedRetentionMs: number,
): Promise<[number, number]> {
  const now = Date.now();
  const [completed, failed] = await Promise.all([
    prisma.telegramUpdate.deleteMany({
      where: {
        status: 'COMPLETED',
        completedAt: { lt: new Date(now - completedRetentionMs) },
      },
    }),
    prisma.telegramUpdate.deleteMany({
      where: {
        status: 'FAILED',
        receivedAt: { lt: new Date(now - failedRetentionMs) },
      },
    }),
  ]);

  return [completed.count, failed.count];
}

export async function enqueueTelegramUpdateRepo(
  updateId: bigint,
  payload: Prisma.InputJsonValue,
  partitionKey: string,
  lane: string,
): Promise<void> {
  await prisma.telegramUpdate.create({
    data: {
      updateId,
      payload,
      partitionKey,
      lane,
    },
  });
}

export function isDuplicatePrismaErrorRepo(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
