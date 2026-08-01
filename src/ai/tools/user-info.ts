import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { BotContext } from '../../bot';
import { prisma } from '../../db';
import { getUserPersonalMemories } from '../../tools/memory';
import { getAllUserFacts } from '../../tools/user/fact-analyzer';

const userInfoInputSchema = z.object({
  userId: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe(
      'ID пользователя из списка пользователей текущего чата. Если не указан, используется текущий пользователь.',
    ),
});

function isGroupChat(ctx: BotContext): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

export const createUserInfoTool = (ctx?: BotContext) =>
  dynamicTool({
    description:
      'Получение информации о пользователе: все известные факты и личная память.',
    inputSchema: userInfoInputSchema,
    execute: async (input: unknown) => {
      if (!ctx?.from || ctx.chatId === undefined) {
        return JSON.stringify({
          error: 'Не удалось определить пользователя или чат',
        });
      }

      const { userId } = input as { userId?: string };
      const currentUserId = BigInt(ctx.from.id);
      const targetUserId = userId ? BigInt(userId) : currentUserId;
      const isCurrentUser = targetUserId === currentUserId;
      const chatId = BigInt(ctx.chatId);

      try {
        if (!isCurrentUser) {
          if (!isGroupChat(ctx)) {
            return JSON.stringify({
              error:
                'Информацию можно получать только о пользователях текущей группы',
            });
          }

          const participant = await prisma.message.findFirst({
            where: {
              chatId,
              senderId: targetUserId,
              private: false,
            },
            select: { id: true },
          });

          if (!participant) {
            return JSON.stringify({
              error: 'Пользователь не является участником текущего чата',
            });
          }
        }

        const user = await prisma.user.findUnique({
          where: { id: targetUserId },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            userName: true,
          },
        });

        if (!user) {
          return JSON.stringify({ error: 'Пользователь не найден' });
        }

        const [facts, personalMemories] = await Promise.all([
          getAllUserFacts(targetUserId),
          getUserPersonalMemories(
            targetUserId,
            isCurrentUser ? { allChats: true } : { chatId },
          ),
        ]);

        return JSON.stringify({
          user: {
            id: user.id.toString(),
            firstName: user.firstName,
            lastName: user.lastName,
            userName: user.userName,
          },
          facts: facts.map((fact) => ({
            ...fact,
            updatedAt: fact.updatedAt.toISOString(),
            expiresAt: fact.expiresAt?.toISOString() ?? null,
          })),
          personalMemories: personalMemories.map((memory) => ({
            content: memory.content,
            createdAt: memory.createdAt.toISOString(),
            updatedAt: memory.updatedAt.toISOString(),
          })),
          memoryScope: isCurrentUser ? 'all_chats' : 'current_chat',
        });
      } catch (_error) {
        return JSON.stringify({
          error: 'Не удалось получить информацию о пользователе',
        });
      }
    },
  });
