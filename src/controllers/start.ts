import type { Context } from 'grammy';
import { startSubscriptionController } from './subscription';

export const startController = async (ctx: Context) => {
  if (await startSubscriptionController(ctx)) return;
  await ctx.reply('Я жив');
};
