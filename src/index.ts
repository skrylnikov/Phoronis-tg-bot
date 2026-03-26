import { GrammyError, HttpError } from 'grammy';
import { bot } from './bot';

import { controllers } from './controllers';
import { prisma } from './db';
import { logger } from './logger';
import { ensureQdrantCollections } from './qdrant-init';
import { startScheduler } from './scheduler';
import { handleError } from './utils/error-handler';

bot.use(controllers);

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

await ensureQdrantCollections();
startScheduler();

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

const shutdown = () => {
  logger.info('Shutting down the bot');
  return Promise.all([bot.stop(), prisma.$disconnect()]);
};

// Stopping the bot when the Node.js process
// is about to be terminated
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
