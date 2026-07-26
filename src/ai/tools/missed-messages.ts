import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { BotContext } from '../../bot';
import { prisma } from '../../db';
import { logger } from '../../logger';

const maxMessages = 500;
const maxContextCharacters = 60_000;
const moscowOffsetMilliseconds = 3 * 60 * 60 * 1000;

const missedMessagesInputSchema = z.object({
  startAt: z.iso.datetime({ offset: true }).optional(),
  endAt: z.iso.datetime({ offset: true }).optional(),
});

export function canUseMissedMessagesTool(
  ctx: BotContext | undefined,
  readOnlyTools: boolean,
): boolean {
  return (
    !readOnlyTools &&
    (ctx?.chat?.type === 'group' || ctx?.chat?.type === 'supergroup')
  );
}

function getMoscowDayStart(date: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return new Date(
    Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
    ) - moscowOffsetMilliseconds,
  );
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function getSenderName(sender: {
  firstName: string | null;
  lastName: string | null;
  userName: string | null;
}): string {
  if (sender.userName) return `@${sender.userName}`;

  const fullName = [sender.firstName, sender.lastName]
    .filter((part): part is string => Boolean(part))
    .join(' ');

  return fullName || 'Неизвестный пользователь';
}

export async function getMissedMessages(
  ctx: BotContext | undefined,
  rawInput: unknown,
): Promise<string> {
  const input = missedMessagesInputSchema.safeParse(rawInput);
  if (!input.success) {
    logger.error({ error: input.error }, 'Invalid get_missed_messages input');
    return JSON.stringify({ error: 'Некорректный интервал времени' });
  }

  if (!ctx?.from || !ctx.chatId || !ctx.msg) {
    logger.error('Missing context for get_missed_messages');
    return JSON.stringify({ error: 'Не удалось определить контекст чата' });
  }

  if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') {
    logger.error('Non-group context for get_missed_messages');
    return JSON.stringify({ error: 'История доступна только в группах' });
  }

  const startAt = parseDate(input.data.startAt);
  const requestedEndAt = parseDate(input.data.endAt);
  if (
    (input.data.startAt && !startAt) ||
    (input.data.endAt && !requestedEndAt)
  ) {
    logger.error('Invalid date for get_missed_messages');
    return JSON.stringify({ error: 'Некорректный интервал времени' });
  }

  const currentMessageId = BigInt(ctx.msg.message_id);
  const currentMessageTime = new Date(ctx.msg.date * 1000);
  const endAt =
    requestedEndAt && requestedEndAt < currentMessageTime
      ? requestedEndAt
      : currentMessageTime;
  const usesExplicitRange = Boolean(input.data.startAt || input.data.endAt);
  let effectiveStartAt = startAt ?? getMoscowDayStart(currentMessageTime);
  let afterMessageId: bigint | undefined;

  if (effectiveStartAt >= endAt) {
    logger.error('Reversed interval for get_missed_messages');
    return JSON.stringify({
      error: 'Начало интервала должно быть раньше конца',
    });
  }

  try {
    if (!usesExplicitRange) {
      const lastUserMessage = await prisma.message.findFirst({
        where: {
          chatId: BigInt(ctx.chatId),
          senderId: BigInt(ctx.from.id),
          private: false,
          id: { lt: currentMessageId },
          sentAt: { gte: effectiveStartAt, lt: endAt },
        },
        orderBy: { id: 'desc' },
        select: { id: true, sentAt: true },
      });

      if (lastUserMessage) {
        effectiveStartAt = lastUserMessage.sentAt;
        afterMessageId = lastUserMessage.id;
      }
    }

    const rows = await prisma.message.findMany({
      where: {
        chatId: BigInt(ctx.chatId),
        private: false,
        id: {
          lt: currentMessageId,
          ...(afterMessageId !== undefined ? { gt: afterMessageId } : {}),
        },
        sentAt: { gte: effectiveStartAt, lt: endAt },
        OR: [{ text: { not: null } }, { summary: { not: null } }],
      },
      select: {
        id: true,
        replyToMessageId: true,
        messageType: true,
        sentAt: true,
        text: true,
        summary: true,
        sender: {
          select: { firstName: true, lastName: true, userName: true },
        },
      },
      orderBy: { id: 'desc' },
      take: maxMessages + 1,
    });

    const result = [] as Array<{
      id: string;
      replyToMessageId: string | null;
      sender: string;
      sentAt: string;
      type: string;
      content: string;
    }>;
    let truncated = rows.length > maxMessages;
    let contextCharacters = 0;

    for (const row of rows.slice(0, maxMessages)) {
      const content = (row.summary || row.text || '').trim();
      if (!content) continue;

      const message = {
        id: row.id.toString(),
        replyToMessageId: row.replyToMessageId?.toString() ?? null,
        sender: getSenderName(row.sender),
        sentAt: row.sentAt.toISOString(),
        type: row.messageType,
        content,
      };
      const messageCharacters = JSON.stringify(message).length;

      if (contextCharacters + messageCharacters > maxContextCharacters) {
        truncated = true;
        break;
      }

      contextCharacters += messageCharacters;
      result.push(message);
    }

    return JSON.stringify({
      startAt: effectiveStartAt.toISOString(),
      endAt: endAt.toISOString(),
      truncated,
      ...(truncated
        ? {
            notice:
              'История усечена. В ответе обязательно сообщи, что показана только доступная наиболее свежая часть периода.',
          }
        : {}),
      messages: result.reverse(),
    });
  } catch (error) {
    logger.error(error, 'get_missed_messages failed');
    return JSON.stringify({ error: 'Не удалось получить историю сообщений' });
  }
}

export const createMissedMessagesTool = (ctx?: BotContext) =>
  dynamicTool({
    description:
      'Получить сообщения, которые пользователь мог пропустить в текущей группе. Используй только когда пользователь явно спрашивает, что он пропустил, просит сводку недавнего чата или историю за период. Если пользователь назвал период, передай его точные границы в startAt и endAt в ISO 8601 с часовым поясом; если не назвал, не передавай параметры. После получения результата сделай сводку. Если truncated равно true, обязательно скажи пользователю, что показана только наиболее свежая доступная часть периода.',
    inputSchema: missedMessagesInputSchema,
    execute: (input: unknown) => getMissedMessages(ctx, input),
  });
