import { beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundJobRunner } from '../background-job-runner';
import { prisma } from '../db';
import {
  backgroundJobBackoffMs,
  claimNextBackgroundJobRepo,
  completeBackgroundJobRepo,
  enqueueBackgroundJobRepo,
  failBackgroundJobRepo,
  heartbeatBackgroundJobRepo,
  releaseBackgroundJobLeaseRepo,
} from '../repositories/background-job-repository';
import { updateMessageEmbeddingRepo } from '../repositories/embedding-repository';
import { saveMessage } from '../repositories/message-repository';
import { activatePaymentWithSubscription } from '../repositories/subscription-repository';
import {
  claimNextTelegramUpdateRepo,
  enqueueTelegramUpdateRepo,
  markTelegramUpdateCompletedRepo,
} from '../repositories/telegram-update-repository';
import { createTelegramUpdateQueue } from '../telegram-update-queue';
import { currentUpdateAbortSignal } from '../update-signal';

let sequence = 0;

function uniqueKey(prefix: string): string {
  sequence += 1;
  return `integration:${prefix}:${Date.now()}:${sequence}`;
}

function uniqueId(): bigint {
  sequence += 1;
  return BigInt(Date.now()) * 1000n + BigInt(sequence);
}

async function waitForBackgroundJobStatus(
  id: string,
  status: 'PENDING' | 'COMPLETED',
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await prisma.backgroundJob.findUnique({ where: { id } });
    if (job?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Background job ${id} did not reach ${status}`);
}

describe('architecture integration', () => {
  beforeEach(async () => {
    await prisma.backgroundJob.deleteMany();
    await prisma.telegramUpdate.deleteMany();
  });

  test('deduplicates and serializes concurrent background job claims', async () => {
    const dedupeKey = uniqueKey('claim');
    await enqueueBackgroundJobRepo({
      type: 'USER_MESSAGE_ANALYSIS',
      dedupeKey,
      payload: { userId: '1', chatId: '2', isGroup: false },
      availableAt: new Date(Date.now() - 1000),
    });
    await enqueueBackgroundJobRepo({
      type: 'USER_MESSAGE_ANALYSIS',
      dedupeKey,
      payload: { userId: 'different' },
    });

    expect(await prisma.backgroundJob.count({ where: { dedupeKey } })).toBe(1);

    const [first, second] = await Promise.all([
      claimNextBackgroundJobRepo('integration-worker-a', 60_000),
      claimNextBackgroundJobRepo('integration-worker-b', 60_000),
    ]);
    const claimed = [first, second].filter(
      (job): job is NonNullable<typeof job> => job !== undefined,
    );
    expect(claimed).toHaveLength(1);

    const workerId =
      claimed[0]?.id === first?.id
        ? 'integration-worker-a'
        : 'integration-worker-b';
    expect(
      await heartbeatBackgroundJobRepo(claimed[0].id, workerId, 60_000),
    ).toBe(true);
    expect(
      await heartbeatBackgroundJobRepo(
        claimed[0].id,
        workerId === 'integration-worker-a'
          ? 'integration-worker-b'
          : 'integration-worker-a',
        60_000,
      ),
    ).toBe(false);
    expect(await releaseBackgroundJobLeaseRepo(workerId)).toBe(1);
  });

  test('reclaims expired jobs and applies retry backoff', async () => {
    const dedupeKey = uniqueKey('recovery');
    await enqueueBackgroundJobRepo({
      type: 'USER_MESSAGE_ANALYSIS',
      dedupeKey,
      payload: { userId: '3', chatId: '4', isGroup: true },
      availableAt: new Date(Date.now() - 1000),
    });

    const first = await claimNextBackgroundJobRepo('expired-worker', 10);
    expect(first).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const recovered = await claimNextBackgroundJobRepo(
      'recovery-worker',
      60_000,
    );
    expect(recovered?.id).toBe(first?.id);
    expect(recovered?.attempts).toBe(2);
    expect(backgroundJobBackoffMs(recovered?.attempts ?? 0)).toBe(10_000);

    expect(
      await failBackgroundJobRepo({
        id: recovered?.id ?? '',
        workerId: 'recovery-worker',
        attempts: recovered?.attempts ?? 0,
        maxAttempts: 3,
        error: 'temporary failure',
      }),
    ).toBe('retry');
    await prisma.backgroundJob.update({
      where: { id: recovered?.id ?? '' },
      data: { availableAt: new Date(0) },
    });
    const finalAttempt = await claimNextBackgroundJobRepo(
      'terminal-worker',
      60_000,
    );
    expect(finalAttempt?.id).toBe(first?.id);
    expect(
      await failBackgroundJobRepo({
        id: finalAttempt?.id ?? '',
        workerId: 'terminal-worker',
        attempts: finalAttempt?.attempts ?? 0,
        maxAttempts: finalAttempt?.attempts ?? 0,
        error: 'terminal failure',
      }),
    ).toBe('failed');
  });

  test('releases a job on worker stop and completes it after restart', async () => {
    const dedupeKey = uniqueKey('runner-restart');
    await enqueueBackgroundJobRepo({
      type: 'USER_MESSAGE_ANALYSIS',
      dedupeKey,
      payload: { userId: '7', chatId: '8', isGroup: false },
      availableAt: new Date(Date.now() - 1000),
    });

    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const firstRunner = createBackgroundJobRunner({
      USER_MESSAGE_ANALYSIS: async (_job, signal) => {
        startedResolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    await firstRunner.start();
    await started;
    await firstRunner.stop();

    const claimed = await prisma.backgroundJob.findUnique({
      where: { dedupeKey },
    });
    expect(claimed).toMatchObject({
      status: 'PENDING',
      workerId: null,
      leaseUntil: null,
    });

    const secondRunner = createBackgroundJobRunner({
      USER_MESSAGE_ANALYSIS: async () => {},
    });
    await secondRunner.start();
    await waitForBackgroundJobStatus(claimed?.id ?? '', 'COMPLETED');
    await secondRunner.stop();
  });

  test('creates payment notification jobs in the activation transaction', async () => {
    const userId = uniqueId();
    const beneficiaryChatId = -uniqueId();
    const orderId = uniqueKey('payment');
    const chargeId = uniqueKey('charge');
    const now = new Date();

    await prisma.user.create({ data: { id: userId, firstName: 'Buyer' } });
    await prisma.chat.create({
      data: {
        id: beneficiaryChatId,
        title: 'Integration chat',
        chatType: 'GROUP',
      },
    });
    await prisma.paymentOrder.create({
      data: {
        id: orderId,
        userId,
        beneficiaryChatId,
        plan: 'MONTH',
        baseAmount: 499,
        amount: 399,
        discountPercent: 20,
        termsAcceptedAt: now,
        termsVersion: 'integration',
        expiresAt: new Date(now.getTime() + 60_000),
      },
    });

    const input = {
      orderId,
      userId,
      beneficiaryChatId,
      plan: 'MONTH' as const,
      chargeId,
      startsAt: now,
      durationDays: 30,
      now,
      amount: 399,
      buyer: { firstName: 'Buyer' },
    };
    expect(await activatePaymentWithSubscription(input)).toMatchObject({
      activatedNow: true,
    });
    expect(await activatePaymentWithSubscription(input)).toMatchObject({
      activatedNow: false,
    });

    expect(
      await prisma.backgroundJob.count({
        where: { dedupeKey: { startsWith: `payment-order:${orderId}:` } },
      }),
    ).toBe(3);
    expect(
      await prisma.paymentOrder.findUnique({ where: { id: orderId } }),
    ).toMatchObject({ status: 'PAID', telegramPaymentChargeId: chargeId });
  });

  test('enforces cross-lane ordering and parallel partitions for updates', async () => {
    const firstId = uniqueId();
    const secondId = uniqueId();
    const orderedPartition = uniqueKey('partition-a');
    const firstPayload = {
      update_id: Number(firstId),
      message: { text: 'first' },
    };
    const secondPayload = {
      update_id: Number(secondId),
      message: { text: 'second' },
    };
    await enqueueTelegramUpdateRepo(
      firstId,
      firstPayload,
      orderedPartition,
      'NORMAL',
    );
    await enqueueTelegramUpdateRepo(
      secondId,
      secondPayload,
      orderedPartition,
      'URGENT',
    );

    const blocked = await claimNextTelegramUpdateRepo(
      'URGENT',
      'urgent-worker',
      60_000,
    );
    expect(blocked).toBeUndefined();
    const first = await claimNextTelegramUpdateRepo(
      'NORMAL',
      'normal-worker',
      60_000,
    );
    expect(first?.updateId).toBe(firstId);
    await markTelegramUpdateCompletedRepo(firstId, 'normal-worker');

    const second = await claimNextTelegramUpdateRepo(
      'URGENT',
      'urgent-worker',
      60_000,
    );
    expect(second?.updateId).toBe(secondId);
    await markTelegramUpdateCompletedRepo(secondId, 'urgent-worker');

    const thirdId = uniqueId();
    const fourthId = uniqueId();
    await enqueueTelegramUpdateRepo(
      thirdId,
      { update_id: Number(thirdId) },
      uniqueKey('partition-b'),
      'NORMAL',
    );
    await enqueueTelegramUpdateRepo(
      fourthId,
      { update_id: Number(fourthId) },
      uniqueKey('partition-c'),
      'NORMAL',
    );
    const [third, fourth] = await Promise.all([
      claimNextTelegramUpdateRepo('NORMAL', 'partition-worker-a', 60_000),
      claimNextTelegramUpdateRepo('NORMAL', 'partition-worker-b', 60_000),
    ]);
    expect(new Set([third?.updateId, fourth?.updateId])).toEqual(
      new Set([thirdId, fourthId]),
    );
    const thirdWorker =
      third?.updateId === thirdId ? 'partition-worker-a' : 'partition-worker-b';
    const fourthWorker =
      fourth?.updateId === fourthId
        ? 'partition-worker-b'
        : 'partition-worker-a';
    await markTelegramUpdateCompletedRepo(thirdId, thirdWorker);
    await markTelegramUpdateCompletedRepo(fourthId, fourthWorker);
  });

  test('aborts an active Telegram update and releases its lease on stop', async () => {
    const updateId = uniqueId();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const bot = {
      init: async () => {},
      handleUpdate: async () => {
        startedResolve();
        const signal = currentUpdateAbortSignal();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          if (!signal) {
            reject(new Error('missing update abort signal'));
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
    } as unknown as Parameters<typeof createTelegramUpdateQueue>[0];
    const queue = createTelegramUpdateQueue(bot);
    await queue.enqueue({
      update_id: Number(updateId),
      message: { chat: { id: 123, type: 'private' } },
    } as never);
    await queue.start();
    await started;
    await queue.stop();

    expect(
      await prisma.telegramUpdate.findUnique({ where: { updateId } }),
    ).toMatchObject({ status: 'PENDING', workerId: null, leaseUntil: null });
  });

  test('deduplicates message persistence and keeps embedding writes idempotent', async () => {
    const userId = uniqueId();
    const chatId = -uniqueId();
    const messageId = uniqueId();
    await prisma.user.create({ data: { id: userId, firstName: 'User' } });
    await prisma.chat.create({
      data: { id: chatId, title: 'Integration chat', chatType: 'GROUP' },
    });

    const message = {
      id: messageId,
      chatId,
      senderId: userId,
      sentAt: new Date(),
      messageType: 'TEXT',
      text: 'duplicate-safe',
    } as const;
    const results = await Promise.all([
      saveMessage(message),
      saveMessage(message),
    ]);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(
      await prisma.message.count({ where: { chatId, id: messageId } }),
    ).toBe(1);

    const embedding = Array.from({ length: 384 }, () => 0.01);
    await Promise.all([
      updateMessageEmbeddingRepo(
        chatId,
        messageId,
        'duplicate-safe',
        embedding,
        2,
      ),
      updateMessageEmbeddingRepo(
        chatId,
        messageId,
        'duplicate-safe',
        embedding,
        2,
      ),
    ]);
    expect(
      await prisma.$queryRaw<
        Array<{ searchText: string; embeddingVersion: number }>
      >`
        SELECT "searchText", "embeddingVersion"
        FROM "Message"
        WHERE "chatId" = ${chatId} AND "id" = ${messageId}
      `,
    ).toMatchObject([{ searchText: 'duplicate-safe', embeddingVersion: 2 }]);
  });

  test('completes a claimed background job only for its owner', async () => {
    const dedupeKey = uniqueKey('owner');
    await enqueueBackgroundJobRepo({
      type: 'USER_MESSAGE_ANALYSIS',
      dedupeKey,
      payload: { userId: '5', chatId: '6', isGroup: false },
      availableAt: new Date(Date.now() - 1000),
    });
    const claimed = await claimNextBackgroundJobRepo('owner-a', 60_000);
    expect(claimed).toBeDefined();
    expect(await completeBackgroundJobRepo(claimed?.id ?? '', 'owner-b')).toBe(
      false,
    );
    expect(await completeBackgroundJobRepo(claimed?.id ?? '', 'owner-a')).toBe(
      true,
    );
  });
});
