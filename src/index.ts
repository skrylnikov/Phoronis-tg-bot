import { GrammyError, HttpError } from "grammy";
import { logger } from './logger'

import { controllers } from "./controllers";
import { prisma } from './db'
import { bot } from './bot'
import { startScheduler } from './scheduler';

bot.use(controllers);

bot.catch((err) => {
  const ctx = err.ctx;
  logger.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    logger.error("Error in request:", e.description);
  } else if (e instanceof HttpError) {
    logger.error("Could not contact Telegram:", e);
  } else {
    logger.error(err);
    logger.error("Unknown error:", e);
  }
});

startScheduler();

bot.start().catch((e) => logger.error(e));

logger.info("Bot started");

process.on("uncaughtException", function (err) {
  logger.error("Caught exception: " + err);
});

process.on("unhandledRejection", function (err) {
  logger.error("Caught rejection: " + err);
});

const shutdown = () => {
  logger.info("Shutting down the bot");
  return Promise.all([bot.stop(), prisma.$disconnect()]);
};

// Stopping the bot when the Node.js process
// is about to be terminated
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
