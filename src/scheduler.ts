import cron, { type ScheduledTask } from 'node-cron';
import { sendDailyAnalyticsReport } from './analytics';
import { bot } from './bot';
import { prisma } from './db';
import { cleanOldPrivateMessages } from './features/clean-private-messages';
import { sendInktoberMessage } from './features/inktober';
import { sendSelfieSaturdayMessage } from './features/selfie-saturday';
import { logger } from './logger';
import { recalculateFactImpactScores } from './tools/user/fact-impact-tracker';
import { startMetaInfoMigration } from './tools/user/migrate-meta-info';

let impactScoreTask: ScheduledTask | null = null;

export function startScheduler() {
  logger.info('Запуск планировщика задач...');

  const sendAnalyticsReport = async () => {
    try {
      await sendDailyAnalyticsReport(bot.api);
    } catch (error) {
      logger.error(error, 'Failed to send daily analytics report');
    }
  };

  void sendAnalyticsReport();
  cron.schedule('0 23 * * *', sendAnalyticsReport, {
    timezone: 'Europe/Moscow',
  });

  // Запускать каждую субботу в 12:00 по МСК (UTC+3), т.е. в 9:00 UTC
  // Формат: <минута> <час> <день месяца> <месяц> <день недели>
  cron.schedule(
    '0 9 * * 6',
    async () => {
      logger.info('Запуск задачи "Селфи Суббота"...');
      try {
        const chatsToSend = await prisma.chat.findMany({
          where: { selfieSaturdayEnabled: true },
          select: { id: true }, // Выбираем только ID для эффективности
        });

        if (chatsToSend.length === 0) {
          logger.info('Нет чатов с включенной функцией "Селфи Суббота".');
          return;
        }

        logger.info(
          `Найдено ${chatsToSend.length} чатов для отправки сообщения.`,
        );

        // Используем Promise.allSettled для параллельной отправки и обработки ошибок
        const results = await Promise.allSettled(
          chatsToSend.map((chat) => sendSelfieSaturdayMessage(chat.id)),
        );

        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            logger.error(
              `Ошибка при отправке в чат ${chatsToSend[index].id}:`,
              result.reason,
            );
          }
        });

        logger.info('Задача "Селфи Суббота" завершена.');
      } catch (error) {
        logger.error(error, 'Критическая ошибка в задаче "Селфи Суббота":');
      }
    },
    {
      timezone: 'UTC', // Явно указываем UTC для крона
    },
  );

  // Запускать каждый день в октябре в 9:00 UTC (12:00 по МСК)
  // Формат: <минута> <час> <день месяца> <месяц> <день недели>
  cron.schedule(
    '0 9 * 10 *',
    async () => {
      logger.info('Запуск задачи "Inktober"...');
      try {
        const chatsToSend = await prisma.chat.findMany({
          where: { inktoberEnabled: true },
          select: { id: true }, // Выбираем только ID для эффективности
        });

        if (chatsToSend.length === 0) {
          logger.info('Нет чатов с включенной функцией "Inktober".');
          return;
        }

        logger.info(
          `Найдено ${chatsToSend.length} чатов для отправки сообщения Inktober.`,
        );

        // Используем Promise.allSettled для параллельной отправки и обработки ошибок
        const results = await Promise.allSettled(
          chatsToSend.map((chat) => sendInktoberMessage(chat.id)),
        );

        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            logger.error(
              `Ошибка при отправке Inktober в чат ${chatsToSend[index].id}:`,
              result.reason,
            );
          }
        });

        logger.info('Задача "Inktober" завершена.');
      } catch (error) {
        logger.error(error, 'Критическая ошибка в задаче "Inktober":');
      }
    },
    {
      timezone: 'UTC', // Явно указываем UTC для крона
    },
  );

  logger.info('Планировщик задач настроен.');

  startMetaInfoMigration();

  cron.schedule(
    '0 3 * * 0',
    async () => {
      logger.info('Запуск задачи decay фактов...');
      try {
        const result = await prisma.userFact.updateMany({
          where: {
            updatedAt: {
              lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
            weight: {
              gte: 2,
            },
          },
          data: {
            weight: { decrement: 1 },
          },
        });
        logger.info(`Decay завершён: обновлено ${result.count} фактов`);
      } catch (error) {
        logger.error(error, 'Критическая ошибка в задаче decay фактов:');
      }
    },
    {
      timezone: 'UTC',
    },
  );

  impactScoreTask = cron.schedule('*/30 * * * *', async () => {
    logger.info('Перерасчёт impact score фактов...');
    try {
      await recalculateFactImpactScores();
    } catch (error) {
      logger.error(error, 'Ошибка при перерасчёте impact score:');
    }
  });

  cron.schedule(
    '0 2 * * *',
    async () => {
      logger.info('Запуск очистки старых приватных сообщений...');
      try {
        const deleted = await cleanOldPrivateMessages();
        logger.info(`Очистка завершена. Удалено ${deleted} сообщений.`);
      } catch (error) {
        logger.error(
          error,
          'Критическая ошибка при очистке приватных сообщений:',
        );
      }
    },
    { timezone: 'UTC' },
  );

  logger.info('Планировщик задач настроен полностью.');
}

export function stopImpactScoreRecalculation() {
  if (impactScoreTask) {
    impactScoreTask.stop();
    impactScoreTask = null;
    logger.info('Impact score recalculation scheduler stopped');
  }
}
