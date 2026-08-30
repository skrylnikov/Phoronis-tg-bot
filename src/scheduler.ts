import cron, { type ScheduledTask } from 'node-cron';
import { SCHEDULER_LOCK_KEYS, withAdvisoryLock } from './advisory-lock';
import { sendDailyAnalyticsReport } from './analytics';
import { bot } from './bot';
import { recalculateFactImpactScores } from './domain/user/fact-impact-tracker';
import {
  startMetaInfoMigration,
  stopMetaInfoMigration,
} from './domain/user/migrate-meta-info';
import { cleanOldPrivateMessages } from './features/clean-private-messages';
import { sendInktoberMessage } from './features/inktober';
import { sendSelfieSaturdayMessage } from './features/selfie-saturday';
import { logger } from './logger';
import {
  findManyChatsRepo,
  reactivateInactiveGroupChatsRepo,
  updateUserFactsWeightRepo,
} from './repositories';

const scheduledTasks = new Set<ScheduledTask>();
const activeRuns = new Set<Promise<void>>();
let schedulerStarted = false;

export async function runSchedulerTask(
  name: string,
  lockKey: number,
  task: () => Promise<void>,
): Promise<'completed' | 'skipped' | 'failed'> {
  const startedAt = Date.now();
  try {
    const completed = await withAdvisoryLock(lockKey, async () => {
      await task();
      return true;
    });
    if (!completed) {
      logger.info(
        {
          event: 'scheduler.task_skipped',
          task: name,
          reason: 'advisory_lock',
          durationMs: Date.now() - startedAt,
        },
        'Scheduled task skipped',
      );
      return 'skipped';
    }
    logger.info(
      {
        event: 'scheduler.task_completed',
        task: name,
        durationMs: Date.now() - startedAt,
      },
      'Scheduled task completed',
    );
    return 'completed';
  } catch (err) {
    logger.error(
      {
        event: 'scheduler.task_failed',
        err,
        task: name,
        durationMs: Date.now() - startedAt,
      },
      'Scheduled task failed',
    );
    return 'failed';
  }
}

function trackRun(run: Promise<unknown>): void {
  const tracked = run.then(() => undefined);
  activeRuns.add(tracked);
  void tracked.finally(() => activeRuns.delete(tracked));
}

function scheduleTask(
  expression: string,
  name: string,
  lockKey: number,
  task: () => Promise<void>,
  options?: Parameters<typeof cron.schedule>[2],
): void {
  scheduledTasks.add(
    cron.schedule(
      expression,
      () => trackRun(runSchedulerTask(name, lockKey, task)),
      options,
    ),
  );
}

export function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  logger.info({ event: 'scheduler.started' }, 'Scheduler started');

  const sendAnalyticsReport = async () => {
    try {
      const botUser = await bot.api.getMe();
      await sendDailyAnalyticsReport(bot.api, botUser.id);
    } catch (error) {
      logger.error(
        { event: 'scheduler.daily_analytics_failed', err: error },
        'Failed to send daily analytics report',
      );
      throw error;
    }
  };

  trackRun(
    runSchedulerTask(
      'daily analytics',
      SCHEDULER_LOCK_KEYS.dailyAnalytics,
      sendAnalyticsReport,
    ),
  );
  scheduleTask(
    '0 23 * * *',
    'daily analytics',
    SCHEDULER_LOCK_KEYS.dailyAnalytics,
    sendAnalyticsReport,
    {
      timezone: 'Europe/Moscow',
    },
  );

  const reactivateInactiveChats = async () => {
    try {
      const reactivatedCount = await reactivateInactiveGroupChatsRepo();
      logger.info(
        {
          event: 'scheduler.chat_activity_recovery_completed',
          reactivatedCount,
        },
        'Inactive chat recovery completed',
      );
    } catch (error) {
      logger.error(
        { event: 'scheduler.chat_activity_recovery_failed', err: error },
        'Inactive chat recovery failed',
      );
      throw error;
    }
  };

  scheduleTask(
    '0 1 * * *',
    'chat activity recovery',
    SCHEDULER_LOCK_KEYS.chatActivityRecovery,
    reactivateInactiveChats,
    { timezone: 'Europe/Moscow' },
  );

  // Запускать каждую субботу в 12:00 по МСК (UTC+3), т.е. в 9:00 UTC
  // Формат: <минута> <час> <день месяца> <месяц> <день недели>
  scheduleTask(
    '0 9 * * 6',
    'selfie Saturday',
    SCHEDULER_LOCK_KEYS.selfieSaturday,
    async () => {
      logger.info(
        { event: 'scheduler.selfie_started' },
        'Selfie Saturday task started',
      );
      try {
        const chatsToSend = await findManyChatsRepo(
          { selfieSaturdayEnabled: true },
          { select: { id: true } },
        );

        if (chatsToSend.length === 0) {
          logger.info(
            { event: 'scheduler.selfie_no_targets' },
            'No Selfie Saturday targets',
          );
          return;
        }

        logger.info(
          {
            event: 'scheduler.selfie_targets_found',
            targetCount: chatsToSend.length,
          },
          'Selfie Saturday targets found',
        );

        // Используем Promise.allSettled для параллельной отправки и обработки ошибок
        const results = await Promise.allSettled(
          chatsToSend.map((chat: { id: bigint }) =>
            sendSelfieSaturdayMessage(chat.id),
          ),
        );

        results.forEach(
          (result: PromiseSettledResult<unknown>, index: number) => {
            if (result.status === 'rejected') {
              logger.error(
                {
                  event: 'scheduler.selfie_send_failed',
                  chatId: Number(chatsToSend[index].id),
                  err: result.reason,
                },
                'Selfie Saturday send failed',
              );
            }
          },
        );
        const failures = results.filter(
          (result) => result.status === 'rejected',
        );
        if (failures.length > 0) {
          throw new AggregateError(
            failures.map((result) => result.reason),
            'Selfie Saturday delivery failed',
          );
        }

        logger.info(
          { event: 'scheduler.selfie_completed' },
          'Selfie Saturday task completed',
        );
      } catch (err) {
        logger.error(
          { event: 'scheduler.selfie_failed', err },
          'Selfie Saturday task failed',
        );
        throw err;
      }
    },
    {
      timezone: 'UTC', // Явно указываем UTC для крона
    },
  );

  // Запускать каждый день в октябре в 9:00 UTC (12:00 по МСК)
  // Формат: <минута> <час> <день месяца> <месяц> <день недели>
  scheduleTask(
    '0 9 * 10 *',
    'Inktober',
    SCHEDULER_LOCK_KEYS.inktober,
    async () => {
      logger.info(
        { event: 'scheduler.inktober_started' },
        'Inktober task started',
      );
      try {
        const chatsToSend = await findManyChatsRepo(
          { inktoberEnabled: true },
          { select: { id: true } },
        );

        if (chatsToSend.length === 0) {
          logger.info(
            { event: 'scheduler.inktober_no_targets' },
            'No Inktober targets',
          );
          return;
        }

        logger.info(
          {
            event: 'scheduler.inktober_targets_found',
            targetCount: chatsToSend.length,
          },
          'Inktober targets found',
        );

        // Используем Promise.allSettled для параллельной отправки и обработки ошибок
        const results = await Promise.allSettled(
          chatsToSend.map((chat: { id: bigint }) =>
            sendInktoberMessage(chat.id),
          ),
        );

        results.forEach(
          (result: PromiseSettledResult<unknown>, index: number) => {
            if (result.status === 'rejected') {
              logger.error(
                {
                  event: 'scheduler.inktober_send_failed',
                  chatId: Number(chatsToSend[index].id),
                  err: result.reason,
                },
                'Inktober send failed',
              );
            }
          },
        );
        const failures = results.filter(
          (result) => result.status === 'rejected',
        );
        if (failures.length > 0) {
          throw new AggregateError(
            failures.map((result) => result.reason),
            'Inktober delivery failed',
          );
        }

        logger.info(
          { event: 'scheduler.inktober_completed' },
          'Inktober task completed',
        );
      } catch (err) {
        logger.error(
          { event: 'scheduler.inktober_failed', err },
          'Inktober task failed',
        );
        throw err;
      }
    },
    {
      timezone: 'UTC', // Явно указываем UTC для крона
    },
  );

  logger.info(
    { event: 'scheduler.jobs_registered' },
    'Scheduler jobs registered',
  );

  startMetaInfoMigration();

  scheduleTask(
    '0 3 * * 0',
    'fact decay',
    SCHEDULER_LOCK_KEYS.factDecay,
    async () => {
      logger.info(
        { event: 'scheduler.fact_decay_started' },
        'Fact decay task started',
      );
      try {
        const result = await updateUserFactsWeightRepo();
        logger.info(
          {
            event: 'scheduler.fact_decay_completed',
            updatedCount: result,
          },
          'Fact decay task completed',
        );
      } catch (err) {
        logger.error(
          { event: 'scheduler.fact_decay_failed', err },
          'Fact decay task failed',
        );
        throw err;
      }
    },
    {
      timezone: 'UTC',
    },
  );

  scheduleTask(
    '*/30 * * * *',
    'fact impact score',
    SCHEDULER_LOCK_KEYS.factImpact,
    async () => {
      logger.info(
        { event: 'scheduler.fact_impact_started' },
        'Fact impact task started',
      );
      try {
        await recalculateFactImpactScores();
      } catch (err) {
        logger.error(
          { event: 'scheduler.fact_impact_failed', err },
          'Fact impact task failed',
        );
        throw err;
      }
    },
  );

  scheduleTask(
    '0 2 * * *',
    'private message cleanup',
    SCHEDULER_LOCK_KEYS.privateMessageCleanup,
    async () => {
      logger.info(
        { event: 'scheduler.private_cleanup_started' },
        'Private message cleanup started',
      );
      try {
        const deleted = await cleanOldPrivateMessages();
        logger.info(
          {
            event: 'scheduler.private_cleanup_completed',
            deletedCount: deleted,
          },
          'Private message cleanup completed',
        );
      } catch (err) {
        logger.error(
          { event: 'scheduler.private_cleanup_failed', err },
          'Private message cleanup failed',
        );
        throw err;
      }
    },
    { timezone: 'UTC' },
  );

  logger.info({ event: 'scheduler.ready' }, 'Scheduler ready');
}

export async function stopScheduler(): Promise<void> {
  if (!schedulerStarted) return;
  schedulerStarted = false;
  for (const task of scheduledTasks) task.stop();
  scheduledTasks.clear();
  await stopMetaInfoMigration();
  await Promise.allSettled([...activeRuns]);
  logger.info({ event: 'scheduler.stopped' }, 'Scheduler stopped');
}
