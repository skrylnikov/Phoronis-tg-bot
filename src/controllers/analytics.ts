import { buildAnalyticsSnapshot, formatAnalyticsReport } from '../analytics';
import type { BotContext } from '../bot';
import { analyticsChatId } from '../config';

export async function analyticsController(ctx: BotContext): Promise<void> {
  if (ctx.chat?.type !== 'private' || ctx.from?.id !== analyticsChatId) {
    return;
  }

  const snapshot = await buildAnalyticsSnapshot(ctx.me.id, new Date());
  await ctx.reply(formatAnalyticsReport(snapshot));
}
