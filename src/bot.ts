import { Bot, type Context } from 'grammy';
import { token } from './config';

export type BotContext = Context;

export const bot = new Bot<BotContext>(token);
