import type { BotContext } from '../../bot';
import { prisma } from '../../db';
import { logger } from '../../logger';

async function findUserIdByUsername(userName: string): Promise<number | null> {
  try {
    const user = await prisma.user.findFirst({
      where: { userName },
      select: { id: true },
    });

    return user ? Number(user.id) : null;
  } catch (error) {
    logger.error(error, `Error finding user by username: ${userName}`);
    return null;
  }
}

export async function extractMentionedUserIds(
  ctx: BotContext,
): Promise<number[]> {
  const userIds = new Set<number>();

  const processEntities = async (entities: unknown[] | undefined) => {
    if (!entities) return;

    for (const entity of entities) {
      if (!entity || typeof entity !== 'object') continue;

      const e = entity as { type?: string; user?: { id: number } };

      if (e.type === 'text_mention' && e.user?.id) {
        userIds.add(e.user.id);
      }

      if (e.type === 'mention') {
        const mentionEntity = entity as {
          type: string;
          offset: number;
          length: number;
        };

        const text =
          ctx.msg?.text ||
          ctx.msg?.caption ||
          (ctx.msg as { text?: string; caption?: string })?.text ||
          '';

        const userName = text
          .slice(
            mentionEntity.offset,
            mentionEntity.offset + mentionEntity.length,
          )
          .replace('@', '')
          .trim();

        if (userName) {
          const userId = await findUserIdByUsername(userName);
          if (userId) {
            userIds.add(userId);
          }
        }
      }
    }
  };

  await Promise.all([
    processEntities(ctx.msg?.entities),
    processEntities(ctx.msg?.caption_entities),
  ]);

  return Array.from(userIds);
}
