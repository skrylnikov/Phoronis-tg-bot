import { GrammyError, HttpError } from "grammy";
import { consola } from 'consola';

import { controllers } from "./controllers";
import { prisma } from './db'
import { bot } from './bot'

bot.use(controllers);

bot.catch((err) => {
  const ctx = err.ctx;
  consola.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    consola.error("Error in request:", e.description);
  } else if (e instanceof HttpError) {
    consola.error("Could not contact Telegram:", e);
  } else {
    consola.error(err);
    consola.error("Unknown error:", e);
  }
});


bot.start().catch((e) => consola.error(e));

consola.info("Bot started");

process.on("uncaughtException", function (err) {
  consola.error("Caught exception: " + err);
});

process.on("unhandledRejection", function (err) {
  consola.error("Caught rejection: " + err);
});

const shutdown = () => {
  consola.info("Shutting down the bot");
  return Promise.all([bot.stop(), prisma.$disconnect()]);
};

// Stopping the bot when the Node.js process
// is about to be terminated
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
