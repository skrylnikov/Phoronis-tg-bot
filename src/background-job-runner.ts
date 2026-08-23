import { jobConfig } from './job-config';
import { logger } from './logger';
import {
  type ClaimedBackgroundJob,
  claimNextBackgroundJobRepo,
  completeBackgroundJobRepo,
  countBackgroundJobBacklogRepo,
  failBackgroundJobRepo,
  heartbeatBackgroundJobRepo,
  releaseBackgroundJobLeaseRepo,
} from './repositories';
import { runtimeState } from './runtime-state';

export type BackgroundJobHandler = (
  job: ClaimedBackgroundJob,
  signal: AbortSignal,
) => Promise<void>;

export interface BackgroundJobRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2000,
  );
}

export function createBackgroundJobRunner(
  handlers: Record<string, BackgroundJobHandler>,
): BackgroundJobRunner {
  let stopping = false;
  let workers: Promise<void>[] = [];
  const activeControllers = new Set<AbortController>();
  let backlogLoggedAt = 0;

  async function processJobs(): Promise<void> {
    const workerId = `job-${crypto.randomUUID()}`;
    while (!stopping) {
      let job: ClaimedBackgroundJob | undefined;
      try {
        job = await claimNextBackgroundJobRepo(
          workerId,
          jobConfig.leaseDurationMs,
        );
      } catch (error) {
        logger.error(
          { event: 'job.worker_claim_failed', err: error },
          'Failed to claim background job',
        );
        await delay(jobConfig.pollIntervalMs);
        continue;
      }
      if (!job) {
        if (Date.now() - backlogLoggedAt >= 60_000) {
          backlogLoggedAt = Date.now();
          const backlog = await countBackgroundJobBacklogRepo().catch(
            () => undefined,
          );
          if (backlog) {
            logger.info(
              { event: 'job.backlog', ...backlog },
              'Background job backlog measured',
            );
          }
        }
        await delay(jobConfig.pollIntervalMs);
        continue;
      }

      const handler = handlers[job.type];
      const controller = new AbortController();
      activeControllers.add(controller);
      const heartbeat = setInterval(
        () => {
          void heartbeatJob(job as ClaimedBackgroundJob, workerId, controller);
        },
        Math.max(1_000, Math.floor(jobConfig.leaseDurationMs / 3)),
      );
      const startedAt = Date.now();

      try {
        if (!handler)
          throw new Error(`No handler for background job ${job.type}`);
        await handler(job, controller.signal);
        if (!controller.signal.aborted) {
          const completed = await completeBackgroundJobRepo(job.id, workerId);
          if (completed) {
            logger.info(
              {
                event: 'job.completed',
                jobId: job.id,
                jobType: job.type,
                dedupeKey: job.dedupeKey,
                attempts: job.attempts,
                durationMs: Date.now() - startedAt,
              },
              'Background job completed',
            );
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          logger.warn(
            {
              event: 'job.lease_lost',
              jobId: job.id,
              jobType: job.type,
              dedupeKey: job.dedupeKey,
              err: error,
            },
            'Background job stopped after lease loss or shutdown',
          );
        } else {
          const outcome = await failBackgroundJobRepo({
            id: job.id,
            workerId,
            attempts: job.attempts,
            maxAttempts: jobConfig.maxAttempts,
            error: errorMessage(error),
          });
          logger.warn(
            {
              event: outcome === 'failed' ? 'job.failed' : 'job.retry',
              jobId: job.id,
              jobType: job.type,
              dedupeKey: job.dedupeKey,
              attempts: job.attempts,
              outcome,
              err: error,
            },
            'Background job processing failed',
          );
        }
      } finally {
        clearInterval(heartbeat);
        activeControllers.delete(controller);
      }
    }

    await releaseBackgroundJobLeaseRepo(workerId);
  }

  async function heartbeatJob(
    job: ClaimedBackgroundJob,
    workerId: string,
    controller: AbortController,
  ): Promise<void> {
    if (controller.signal.aborted) return;
    try {
      const renewed = await heartbeatBackgroundJobRepo(
        job.id,
        workerId,
        jobConfig.leaseDurationMs,
      );
      if (!renewed) controller.abort(new Error('Background job lease lost'));
    } catch (error) {
      controller.abort(error);
    }
  }

  return {
    async start() {
      stopping = false;
      workers = Array.from({ length: jobConfig.workers }, processJobs);
      runtimeState.setReady('jobWorker', true);
      logger.info(
        { event: 'job.worker_started', workers: jobConfig.workers },
        'Background job worker started',
      );
    },
    async stop() {
      stopping = true;
      runtimeState.setReady('jobWorker', false);
      for (const controller of activeControllers) {
        controller.abort(new Error('Background job runner is stopping'));
      }
      await Promise.all(workers);
      workers = [];
      logger.info(
        { event: 'job.worker_stopped' },
        'Background job worker stopped',
      );
    },
  };
}
