import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { BotContext } from '../../bot';
import { saveMemory } from '../../tools/memory';

export const createMemoryTool = (ctx?: BotContext) =>
  dynamicTool({
    description:
      'Сохранить важную информацию в память. Используй когда пользователь просит что-то запомнить или когда это важная информация о пользователе или чате.',
    inputSchema: z.object({
      content: z.string().describe('Информация для сохранения в памяти'),
      scope: z
        .enum(['personal', 'shared'])
        .describe(
          'personal - личная память пользователя, shared - общая память чата',
        ),
    }),
    execute: async (input: unknown) => {
      console.log('Executing memory tool with input:', input);
      const { content, scope } = input as {
        content: string;
        scope: 'personal' | 'shared';
      };

      if (!ctx?.from || !ctx?.chatId) {
        return 'Ошибка: не удалось определить пользователя или чат';
      }

      const isUser = scope === 'personal';

      try {
        await saveMemory({
          userId: ctx.from.id,
          chatId: ctx.chatId,
          content,
          isUser,
        });

        return `Сохранено в ${isUser ? 'личную' : 'общую'} память: ${content}`;
      } catch (error) {
        console.error('Error saving memory:', error);
        return 'Ошибка при сохранении в память';
      }
    },
  });
