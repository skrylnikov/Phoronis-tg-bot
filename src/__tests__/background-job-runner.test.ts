import { AnalysisStageError } from '../domain/user/analysis-stage';

vi.mock('../repositories/background-job-repository', () => ({
  deferAnalysisJobRepo: mocks.defer,
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimedBackgroundJob } from '../repositories/background-job-repository';

const mocks = vi.hoisted(() => {
  process.env.JOB_POLL_INTERVAL_MS = '1';
  process.env.JOB_LEASE_DURATION_MS = '1000';
  return {
    claimNextBackgroundJobRepo: vi.fn(),
    completeBackgroundJobRepo: vi.fn(),
    countBackgroundJobBacklogRepo: vi.fn(),
    failBackgroundJobRepo: vi.fn(),
    heartbeatBackgroundJobRepo: vi.fn(),
    releaseBackgroundJobLeaseRepo: vi.fn(),
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    setReady: vi.fn(),
    defer: vi.fn(),
  };
});

vi.mock('../repositories', () => ({
  claimNextBackgroundJobRepo: mocks.claimNextBackgroundJobRepo,
  completeBackgroundJobRepo: mocks.completeBackgroundJobRepo,
  countBackgroundJobBacklogRepo: mocks.countBackgroundJobBacklogRepo,
  failBackgroundJobRepo: mocks.failBackgroundJobRepo,
  heartbeatBackgroundJobRepo: mocks.heartbeatBackgroundJobRepo,
  releaseBackgroundJobLeaseRepo: mocks.releaseBackgroundJobLeaseRepo,
}));
vi.mock('../logger', () => ({ logger: mocks.logger }));
vi.mock('../runtime-state', () => ({
  runtimeState: { setReady: mocks.setReady },
}));

import { createBackgroundJobRunner } from '../background-job-runner';

function paymentJob(): ClaimedBackgroundJob {
  return {
    id: 'job-1',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    workerId: 'worker-1',
    type: 'PAYMENT_BUYER_NOTIFICATION',
    dedupeKey: 'payment-order:order-1:buyer',
    payload: { orderId: 'order-1' },
    attempts: 1,
    externalDeliveryId: null,
  };
}

describe('background job runner delivery lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.completeBackgroundJobRepo.mockResolvedValue(true);
    mocks.countBackgroundJobBacklogRepo.mockResolvedValue({
      pending: 0,
      processing: 0,
      failed: 0,
    });
    mocks.failBackgroundJobRepo.mockResolvedValue('retry');
    mocks.heartbeatBackgroundJobRepo.mockResolvedValue(true);
    mocks.releaseBackgroundJobLeaseRepo.mockResolvedValue(0);
  });

  it('completes one durable payment job with its external delivery id', async () => {
    const job = paymentJob();
    mocks.claimNextBackgroundJobRepo
      .mockResolvedValueOnce(job)
      .mockResolvedValue(undefined);
    let handled!: () => void;
    const handledPromise = new Promise<void>((resolve) => {
      handled = resolve;
    });
    const runner = createBackgroundJobRunner({
      PAYMENT_BUYER_NOTIFICATION: async () => {
        handled();
        return { externalDeliveryId: '101' };
      },
    });

    await runner.start();
    await handledPromise;
    await runner.stop();

    expect(mocks.completeBackgroundJobRepo).toHaveBeenCalledWith(
      'job-1',
      expect.stringMatching(/^job-/),
      '101',
    );
  });

  it('leaves a temporary payment failure available for retry', async () => {
    const job = paymentJob();
    job.attempts = 2;
    mocks.claimNextBackgroundJobRepo
      .mockResolvedValueOnce(job)
      .mockResolvedValue(undefined);
    let handled!: () => void;
    const handledPromise = new Promise<void>((resolve) => {
      handled = resolve;
    });
    const runner = createBackgroundJobRunner({
      PAYMENT_BUYER_NOTIFICATION: async () => {
        handled();
        throw new Error('Telegram temporarily unavailable');
      },
    });

    await runner.start();
    await handledPromise;
    await vi.waitFor(() =>
      expect(mocks.failBackgroundJobRepo).toHaveBeenCalled(),
    );
    await runner.stop();

    expect(mocks.failBackgroundJobRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'job-1',
        attempts: 2,
        maxAttempts: 5,
        error: 'Telegram temporarily unavailable',
      }),
    );
    const attemptLog = mocks.logger.info.mock.calls.find(
      ([fields]) => fields?.event === 'job.attempt_started',
    );
    expect(attemptLog?.[0]).toMatchObject({
      jobId: 'job-1',
      paymentOrderId: 'order-1',
      correlationId: 'job-1',
      retryAfterUnknownDelivery: true,
    });
    const retryLog = mocks.logger.warn.mock.calls.find(
      ([fields]) => fields?.event === 'job.retry',
    );
    expect(retryLog?.[0]).toMatchObject({
      jobId: 'job-1',
      paymentOrderId: 'order-1',
      correlationId: 'job-1',
      retryAfterUnknownDelivery: true,
    });
  });

  it('defers analysis without completing or consuming an error retry', async () => {
    mocks.defer.mockResolvedValue(true);
    mocks.claimNextBackgroundJobRepo
      .mockResolvedValueOnce({ ...paymentJob(), type: 'USER_MESSAGE_ANALYSIS' })
      .mockResolvedValue(undefined);
    const date = new Date('2026-10-05T21:00:00Z');
    const runner = createBackgroundJobRunner({
      USER_MESSAGE_ANALYSIS: async () => ({
        deferUntil: date,
        outcome: 'quota_deferred',
      }),
    });
    await runner.start();
    await vi.waitFor(() => expect(mocks.defer).toHaveBeenCalled());
    await runner.stop();
    expect(mocks.defer).toHaveBeenCalledWith(
      'job-1',
      expect.stringMatching(/^job-/),
      date,
    );
    expect(mocks.completeBackgroundJobRepo).not.toHaveBeenCalled();
    expect(mocks.failBackgroundJobRepo).not.toHaveBeenCalled();
  });
  it('terminates invalid analysis input while retaining the usual payment retry budget', async () => {
    mocks.claimNextBackgroundJobRepo
      .mockResolvedValueOnce({
        ...paymentJob(),
        type: 'USER_MESSAGE_ANALYSIS',
        attempts: 1,
      })
      .mockResolvedValue(undefined);
    const runner = createBackgroundJobRunner({
      USER_MESSAGE_ANALYSIS: async () => {
        throw new AnalysisStageError('window', 'invalid_input');
      },
    });
    await runner.start();
    await vi.waitFor(() =>
      expect(mocks.failBackgroundJobRepo).toHaveBeenCalled(),
    );
    await runner.stop();
    expect(mocks.failBackgroundJobRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 1,
        maxAttempts: 1,
        error: 'analysis:window:invalid_input',
      }),
    );
  });

  it('lease loss aborts the handler before another persistence step', async () => {
    mocks.claimNextBackgroundJobRepo
      .mockResolvedValueOnce({ ...paymentJob(), type: 'USER_MESSAGE_ANALYSIS' })
      .mockResolvedValue(undefined);
    mocks.heartbeatBackgroundJobRepo.mockResolvedValue(false);
    let ready!: () => void;
    let aborted!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const lost = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let writes = 0;
    const runner = createBackgroundJobRunner({
      USER_MESSAGE_ANALYSIS: async (_job, signal) => {
        ready();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted();
              resolve();
            },
            { once: true },
          ),
        );
        signal.throwIfAborted();
        writes++;
      },
    });
    await runner.start();
    await started;
    await lost;
    await runner.stop();
    expect(writes).toBe(0);
    expect(mocks.completeBackgroundJobRepo).not.toHaveBeenCalled();
    expect(mocks.failBackgroundJobRepo).not.toHaveBeenCalled();
  });

  it('shutdown aborts the inner operation and does not complete it', async () => {
    mocks.claimNextBackgroundJobRepo
      .mockResolvedValueOnce({ ...paymentJob(), type: 'USER_MESSAGE_ANALYSIS' })
      .mockResolvedValue(undefined);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let writes = 0;
    const runner = createBackgroundJobRunner({
      USER_MESSAGE_ANALYSIS: async (_job, signal) => {
        ready();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
        writes++;
      },
    });
    await runner.start();
    await started;
    await runner.stop();
    expect(writes).toBe(0);
    expect(mocks.completeBackgroundJobRepo).not.toHaveBeenCalled();
    expect(mocks.failBackgroundJobRepo).not.toHaveBeenCalled();
  });

  it('allows an at-least-once retry after the completion crash window', async () => {
    const firstJob = paymentJob();
    const recoveredJob = { ...firstJob, attempts: 2 };
    mocks.claimNextBackgroundJobRepo
      .mockResolvedValueOnce(firstJob)
      .mockResolvedValueOnce(recoveredJob)
      .mockResolvedValue(undefined);
    mocks.completeBackgroundJobRepo
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 707 });
    let handledCount = 0;
    let handled!: () => void;
    const handledPromise = new Promise<void>((resolve) => {
      handled = resolve;
    });
    const runner = createBackgroundJobRunner({
      PAYMENT_BUYER_NOTIFICATION: async () => {
        await sendMessage();
        handledCount += 1;
        if (handledCount === 2) handled();
        return { externalDeliveryId: '707' };
      },
    });

    await runner.start();
    await handledPromise;
    await vi.waitFor(() =>
      expect(mocks.completeBackgroundJobRepo).toHaveBeenCalledTimes(2),
    );
    await runner.stop();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const attemptLogs = mocks.logger.info.mock.calls.filter(
      ([fields]) => fields?.event === 'job.attempt_started',
    );
    expect(attemptLogs).toHaveLength(2);
    expect(attemptLogs.map(([fields]) => fields?.correlationId)).toEqual([
      'job-1',
      'job-1',
    ]);
    expect(attemptLogs[1]?.[0]).toMatchObject({
      retryAfterUnknownDelivery: true,
    });
  });
});
