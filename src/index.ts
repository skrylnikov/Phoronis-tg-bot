import { GrammyError, HttpError } from "grammy";

import { controllers } from "./controllers";
import { prisma } from './db'
import { bot } from './bot'

bot.use(controllers);

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error("Error in request:", e.description);
  } else if (e instanceof HttpError) {
    console.error("Could not contact Telegram:", e);
  } else {
    console.error(err);
    console.error("Unknown error:", e);
  }
});


bot.start().catch((e) => console.error(e));

console.log("Bot started");

process.on("uncaughtException", function (err) {
  console.log("Caught exception: " + err);
});

process.on("unhandledRejection", function (err) {
  console.log("Caught rejection: " + err);
});

const shutdown = () => {
  console.log("Shutting down the bot");
  return Promise.all([bot.stop(), prisma.$disconnect()]);
};

// Stopping the bot when the Node.js process
// is about to be terminated
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
