import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { BotContext } from '../../bot';
import { applyOwnerAliasCommand } from '../../domain/user/owner-alias';

const inputSchema = z.strictObject({
  alias: z.string(),
  action: z.enum(['prefer', 'avoid_addressing', 'reject_identity']),
});
export const createMyAliasTool = (ctx?: BotContext) =>
  dynamicTool({
    description:
      'Применить явную просьбу текущего отправителя о собственном псевдониме. Имя и действие проверяются кодом по оригинальному сообщению; результат содержит фактический исход и актуальное обращение.',
    inputSchema,
    execute: async (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      return JSON.stringify(
        parsed.success && ctx
          ? await applyOwnerAliasCommand(ctx, parsed.data)
          : { error: 'Изменение обращения недоступно' },
      );
    },
  });
