import cron from 'node-cron';
import { prisma } from './db';
import { sendSelfieSaturdayMessage } from './features/selfie-saturday';
import { sendInktoberMessage } from './features/inktober';
import { logger } from './logger';

export function startScheduler() {
  logger.info('Запуск планировщика задач...');

  // Запускать каждую субботу в 12:00 по МСК (UTC+3), т.е. в 9:00 UTC
  // Формат: <минута> <час> <день месяца> <месяц> <день недели>
  cron.schedule('0 9 * * 6', async () => {
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

      logger.info(`Найдено ${chatsToSend.length} чатов для отправки сообщения.`);

      // Используем Promise.allSettled для параллельной отправки и обработки ошибок
      const results = await Promise.allSettled(
        chatsToSend.map(chat => sendSelfieSaturdayMessage(chat.id))
      );

      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.error(`Ошибка при отправке в чат ${chatsToSend[index].id}:`, result.reason);
        }
      });

      logger.info('Задача "Селфи Суббота" завершена.');

    } catch (error) {
      logger.error(error, 'Критическая ошибка в задаче "Селфи Суббота":');
    }
  }, {
    timezone: "UTC" // Явно указываем UTC для крона
  });

  // Запускать каждый день в октябре в 9:00 UTC (12:00 по МСК)
  // Формат: <минута> <час> <день месяца> <месяц> <день недели>
  cron.schedule('0 9 * 10 *', async () => {
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

      logger.info(`Найдено ${chatsToSend.length} чатов для отправки сообщения Inktober.`);

      // Используем Promise.allSettled для параллельной отправки и обработки ошибок
      const results = await Promise.allSettled(
        chatsToSend.map(chat => sendInktoberMessage(chat.id))
      );

      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.error(`Ошибка при отправке Inktober в чат ${chatsToSend[index].id}:`, result.reason);
        }
      });

      logger.info('Задача "Inktober" завершена.');

    } catch (error) {
      logger.error(error, 'Критическая ошибка в задаче "Inktober":');
    }
  }, {
    timezone: "UTC" // Явно указываем UTC для крона
  });

  logger.info('Планировщик задач настроен.');
} 
