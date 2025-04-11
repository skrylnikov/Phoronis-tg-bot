import { Bot, Context } from "grammy";
import { hydrateReply } from "@grammyjs/parse-mode";
import type { ParseModeFlavor } from "@grammyjs/parse-mode";
import { token } from "./config";
import { prisma } from "./db";

export type BotContext = ParseModeFlavor<Context>;

export const bot = new Bot<BotContext>(token);

bot.use(hydrateReply);
