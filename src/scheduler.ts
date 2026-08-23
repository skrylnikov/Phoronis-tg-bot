import cron, { type ScheduledTask } from 'node-cron';
import { SCHEDULER_LOCK_KEY, withAdvisoryLock } from './advisory-lock';
import { sendDailyAnalyticsReport } from './analytics';
import { bot } from './bot';
import { recalculateFactImpactScores } from './domain/user/fact-impact-tracker';
import { startMetaInfoMigration } from './domain/user/migrate-meta-info';
import { cleanOldPrivateMessages } from './features/clean-private-messages';
import { sendInktoberMessage } from './features/inktober';
import { sendSelfieSaturdayMessage } from './features/selfie-saturday';
import { logger } from './logger';
import { findManyChatsRepo, updateUserFactsWeightRepo } from './repositories';

let impactScoreTask: ScheduledTask | null = null;

async function runSchedulerTask(
  name: string,
  task: () => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    await withAdvisoryLock(SCHEDULER_LOCK_KEY, task);
    logger.info(
      {
        event: 'scheduler.task_completed',
        task: name,
        durationMs: Date.now() - startedAt,
      },
      'Scheduled task completed',
    );
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
  }
}

export function startScheduler() {
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
    }
  };

  void runSchedulerTask('daily analytics', sendAnalyticsReport);
  cron.schedule(
    '0 23 * * *',
    () => runSchedulerTask('daily analytics', sendAnalyticsReport),
    {
      timezone: 'Europe/Moscow',
    },
  );

  // Запускать каждую субботу в 12:00 по МСК (UTC+3), т.е. в 9:00 UTC
  // Формат: <минута> <час> <день месяца> <месяц> <день недели>
  cron.schedule(
    '0 9 * * 6',
    () =>
      runSchedulerTask('selfie Saturday', async () => {
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

          logger.info(
            { event: 'scheduler.selfie_completed' },
            'Selfie Saturday task completed',
          );
        } catch (err) {
          logger.error(
            { event: 'scheduler.selfie_failed', err },
            'Selfie Saturday task failed',
          );
        }
      }),
    {
      timezone: 'UTC', // Явно указываем UTC для крона
    },
  );

  // Запускать каждый день в октябре в 9:00 UTC (12:00 по МСК)
  // Формат: <минута> <час> <день месяца> <месяц> <день недели>
  cron.schedule(
    '0 9 * 10 *',
    () =>
      runSchedulerTask('Inktober', async () => {
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

          logger.info(
            { event: 'scheduler.inktober_completed' },
            'Inktober task completed',
          );
        } catch (err) {
          logger.error(
            { event: 'scheduler.inktober_failed', err },
            'Inktober task failed',
          );
        }
      }),
    {
      timezone: 'UTC', // Явно указываем UTC для крона
    },
  );

  logger.info(
    { event: 'scheduler.jobs_registered' },
    'Scheduler jobs registered',
  );

  startMetaInfoMigration();

  cron.schedule(
    '0 3 * * 0',
    () =>
      runSchedulerTask('fact decay', async () => {
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
        }
      }),
    {
      timezone: 'UTC',
    },
  );

  impactScoreTask = cron.schedule('*/30 * * * *', () =>
    runSchedulerTask('fact impact score', async () => {
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
      }
    }),
  );

  cron.schedule(
    '0 2 * * *',
    () =>
      runSchedulerTask('private message cleanup', async () => {
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
        }
      }),
    { timezone: 'UTC' },
  );

  logger.info({ event: 'scheduler.ready' }, 'Scheduler ready');
}

export function stopImpactScoreRecalculation() {
  if (impactScoreTask) {
    impactScoreTask.stop();
    impactScoreTask = null;
    logger.info(
      { event: 'scheduler.fact_impact_stopped' },
      'Impact score scheduler stopped',
    );
  }
}
