import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { BotContext } from '../../bot';
import { prisma } from '../../db';
import { getUserPersonalMemories } from '../../domain/memory';
import { getAllUserFacts } from '../../domain/user/fact-analyzer';
import { resolveChatUser } from '../../domain/user/resolve-chat-user';
import { logger } from '../../logger';
import { findUserAliasesRepo } from '../../repositories/user-alias-repository';

const userInfoInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Имя, @username или псевдоним участника текущего чата, вместо userId.',
      ),
    userId: z
      .string()
      .regex(/^\d+$/)
      .optional()
      .describe(
        'ID пользователя из списка пользователей текущего чата. Если не указан, используется текущий пользователь.',
      ),
  })
  .refine(
    (input) => input.query === undefined || input.userId === undefined,
    'Укажите query или userId',
  );

function isGroupChat(ctx: BotContext): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

export const createUserInfoTool = (ctx?: BotContext) =>
  dynamicTool({
    description:
      'Получение информации о текущем пользователе либо публичных фактов участника текущей группы.',
    inputSchema: userInfoInputSchema,
    execute: async (input: unknown) => {
      if (!ctx?.from || ctx.chatId === undefined) {
        return JSON.stringify({
          error: 'Не удалось определить пользователя или чат',
        });
      }

      const parsed = userInfoInputSchema.safeParse(input);
      if (!parsed.success)
        return JSON.stringify({
          error: 'Укажите корректный userId или query, но не оба',
        });
      const { userId, query } = parsed.data;
      const currentUserId = BigInt(ctx.from.id);
      let targetUserId = userId ? BigInt(userId) : currentUserId;
      const chatId = BigInt(ctx.chatId);

      try {
        if (query !== undefined) {
          if (!isGroupChat(ctx))
            return JSON.stringify({
              error: 'Поиск пользователей доступен только в текущей группе',
            });
          const match = await resolveChatUser(chatId, query);
          if ('candidates' in match) {
            const candidates = [];
            for (const candidate of match.candidates) {
              if (candidate.id !== String(currentUserId)) {
                const member = await ctx.api.getChatMember(
                  ctx.chatId,
                  Number(candidate.id),
                );
                if (
                  member.status === 'left' ||
                  member.status === 'kicked' ||
                  (member.status === 'restricted' && !member.is_member)
                )
                  continue;
              }
              candidates.push(candidate);
            }
            return JSON.stringify({ ...match, candidates });
          }
          targetUserId = match.senderId;
        }
        const isCurrentUser = targetUserId === currentUserId;
        if (!isCurrentUser) {
          if (!isGroupChat(ctx)) {
            return JSON.stringify({
              error:
                'Информацию можно получать только о пользователях текущей группы',
            });
          }

          const member = await ctx.api.getChatMember(
            ctx.chatId,
            Number(targetUserId),
          );
          if (
            member.status === 'left' ||
            member.status === 'kicked' ||
            (member.status === 'restricted' && !member.is_member)
          ) {
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

        const [facts, personalMemories, aliases] = await Promise.all([
          getAllUserFacts(
            targetUserId,
            isCurrentUser ? {} : { sourceChatId: chatId },
          ),
          isCurrentUser
            ? getUserPersonalMemories(targetUserId, { allChats: true })
            : [],
          findUserAliasesRepo(chatId, targetUserId),
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
          memoryScope: isCurrentUser ? 'all_chats' : 'none',
          aliases: aliases
            .filter((alias) => alias.status !== 'REJECTED')
            .map(
              ({
                alias,
                confidence,
                status,
                preferred,
                addressingBlocked,
              }) => ({
                alias,
                confidence,
                status,
                preferred,
                addressingBlocked,
              }),
            ),
        });
      } catch (error) {
        logger.error(
          { event: 'user_info.access_failed', err: error },
          'Failed to authorize or load user information',
        );
        return JSON.stringify({
          error: 'Не удалось получить информацию о пользователе',
        });
      }
    },
  });
