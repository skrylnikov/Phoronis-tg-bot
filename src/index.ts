import { GrammyError, HttpError } from 'grammy';
import { startEmbeddingBackfill, stopEmbeddingBackfill } from './ai/embedding';
import { bot } from './bot';
import { registerBotCommands } from './bot-commands';
import { controllers } from './controllers';
import { prisma } from './db';
import { startHealthServer } from './health';
import { logger } from './logger';
import { startScheduler } from './scheduler';
import { handleError } from './utils/error-handler';

bot.use(controllers);

const healthServer = startHealthServer();

bot.catch((err) => {
  const ctx = err.ctx;
  logger.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    logger.error({ description: e.description }, 'Error in request');
  } else if (e instanceof HttpError) {
    logger.error(e, 'Could not contact Telegram');
  } else {
    handleError(e, `Error handling update ${ctx.update.update_id}`);
  }
});

await registerBotCommands(bot.api);
startScheduler();
startEmbeddingBackfill();

bot.start().catch((e) => {
  handleError(e, 'Failed to start bot');
});

logger.info('Bot started');

process.on('uncaughtException', (err) => {
  handleError(err, 'Uncaught exception');
});

process.on('unhandledRejection', (err) => {
  handleError(err, 'Unhandled rejection');
});

const shutdown = async () => {
  logger.info('Shutting down the bot');
  healthServer.stop();
  await stopEmbeddingBackfill();
  await Promise.all([bot.stop(), prisma.$disconnect()]);
};

// Stopping the bot when the Node.js process
// is about to be terminated
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
