import { GrammyError, HttpError } from 'grammy';
import { startEmbeddingBackfill, stopEmbeddingBackfill } from './ai/embedding';
import { bot } from './bot';
import { registerBotCommands } from './bot-commands';
import { transportConfig } from './config';
import { controllers } from './controllers';
import { prisma } from './db';
import { startHealthServer } from './health';
import { logger, telegramLogContext } from './logger';
import { startScheduler } from './scheduler';
import { createBotTransport } from './transport';
import { handleError } from './utils/error-handler';

bot.use(controllers);

const botTransport = createBotTransport(bot, transportConfig, (error) => {
  handleError(error, 'Failed to start bot polling');
});
const healthServer = startHealthServer({
  webhookHandler: botTransport.webhookHandler,
  webhookPath: botTransport.webhookPath,
});

bot.catch((err) => {
  const ctx = err.ctx;
  const log = logger.child(telegramLogContext(ctx));
  log.error(
    { event: 'update.handler_failed', err: err.error },
    'Error while handling Telegram update',
  );
  const e = err.error;
  if (e instanceof GrammyError) {
    log.error(
      { event: 'telegram.request_failed', description: e.description },
      'Error in Telegram request',
    );
  } else if (e instanceof HttpError) {
    log.error(
      { event: 'telegram.unreachable', err: e },
      'Could not contact Telegram',
    );
  } else {
    handleError(e, 'Error handling update', { ...telegramLogContext(ctx) });
  }
});

await registerBotCommands(bot.api);
startScheduler();
startEmbeddingBackfill();
await botTransport.start();

process.on('uncaughtException', (err) => {
  handleError(err, 'Uncaught exception', {
    event: 'process.uncaught_exception',
  });
});

process.on('unhandledRejection', (err) => {
  handleError(err, 'Unhandled rejection', {
    event: 'process.unhandled_rejection',
  });
});

const shutdown = async () => {
  logger.info({ event: 'process.shutdown_started' }, 'Shutting down the bot');
  healthServer.stop();
  await stopEmbeddingBackfill();
  await Promise.all([botTransport.stop(), prisma.$disconnect()]);
  logger.info(
    { event: 'process.shutdown_completed' },
    'Bot shutdown completed',
  );
};

// Stopping the bot when the Node.js process
// is about to be terminated
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
