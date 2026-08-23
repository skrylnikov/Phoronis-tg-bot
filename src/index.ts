import { GrammyError, HttpError } from 'grammy';
import {
  checkEmbeddingHealth,
  startEmbeddingBackfill,
  stopEmbeddingBackfill,
} from './ai/embedding';
import { createBackgroundJobRunner } from './background-job-runner';
import { bot } from './bot';
import { registerBotCommands } from './bot-commands';
import { shutdownDrainMs, transportConfig } from './config';
import { controllers } from './controllers';
import { connectPrismaRepo } from './db';
import { startHealthServer } from './health';
import { shutdownTelemetry, startTelemetry } from './instrumentation';
import { logger, telegramLogContext } from './logger';
import { createPaymentBackgroundJobHandlers } from './payment-background-jobs';
import { disconnectPrismaRepo } from './repositories';
import { readRuntimeConfig } from './runtime-config';
import { createRuntimeShutdown } from './runtime-shutdown';
import { runtimeState } from './runtime-state';
import { startScheduler } from './scheduler';
import { createBotTransport } from './transport';
import { handleError } from './utils/error-handler';

startTelemetry();
bot.use(controllers);

let shutdown: (() => Promise<void>) | undefined;
const botTransport = createBotTransport(bot, transportConfig, (error) => {
  handleError(error, 'Failed to start bot polling');
  process.exitCode = 1;
  void shutdown?.();
});
const healthServer = startHealthServer({
  webhookHandler: botTransport.webhookHandler,
  webhookPath: botTransport.webhookPath,
});

const jobRunner = createBackgroundJobRunner(
  createPaymentBackgroundJobHandlers(bot.api),
);

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

readRuntimeConfig(process.env);
await connectPrismaRepo();
runtimeState.setReady('database', true);
if (!(await checkEmbeddingHealth())) {
  throw new Error('Embeddings service is not ready');
}
runtimeState.setReady('embeddings', true);
await registerBotCommands(bot.api);
startScheduler();
startEmbeddingBackfill();
await jobRunner.start();
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

shutdown = createRuntimeShutdown({
  drainMs: shutdownDrainMs,
  stopHealthServer: () => healthServer.stop(),
  stopTransport: () => botTransport.stop(),
  stopJobRunner: () => jobRunner.stop(),
  stopEmbeddings: () => stopEmbeddingBackfill(),
  disconnectDatabase: () => disconnectPrismaRepo(),
  shutdownTelemetry,
});

// Stopping the bot when the Node.js process
// is about to be terminated
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await botTransport.start();
} catch (error) {
  await shutdown();
  throw error;
}
