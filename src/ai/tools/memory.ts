import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { BotContext } from '../../bot';
import { logger } from '../../logger';
import { clearMemories, saveMemory } from '../../tools/memory';

async function isChatCreator(ctx: BotContext): Promise<boolean> {
  if (!ctx.from || !ctx.chat) {
    return false;
  }
  if (ctx.chat.type === 'private') {
    return true;
  }
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return member.status === 'creator';
  } catch {
    return false;
  }
}

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

export const createClearMemoryTool = (ctx?: BotContext) =>
  dynamicTool({
    description:
      'Очистить сохранённую память бота. В группах доступно только создателю чата. Используй только если пользователь явно просит удалить/очистить память.',
    inputSchema: z.object({
      scope: z
        .enum(['personal', 'shared', 'all'])
        .describe(
          'personal — личная память пользователя в чате, shared — общая память чата, all — и то и другое',
        ),
    }),
    execute: async (input: unknown) => {
      const { scope } = input as { scope: 'personal' | 'shared' | 'all' };

      if (!ctx?.from || !ctx?.chatId) {
        return 'Ошибка: не удалось определить пользователя или чат';
      }

      if (!(await isChatCreator(ctx))) {
        return 'Очистка памяти доступна только создателю чата';
      }

      try {
        const deleted = await clearMemories({
          userId: ctx.from.id,
          chatId: ctx.chatId,
          scope,
        });

        if (deleted === 0) {
          return 'Записей для удаления не найдено';
        }

        const scopeLabel =
          scope === 'personal'
            ? 'личная'
            : scope === 'shared'
              ? 'общая'
              : 'вся';
        return `Удалено записей памяти (${scopeLabel}): ${deleted}`;
      } catch (error) {
        logger.error(error, 'clear_memory tool');
        return 'Ошибка при очистке памяти';
      }
    },
  });
