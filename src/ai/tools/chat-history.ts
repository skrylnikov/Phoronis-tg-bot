import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { BotContext } from '../../bot';
import { prisma } from '../../db';
import type { Prisma } from '../../generated/prisma/client';
import { logger } from '../../logger';
import { embedQuery } from '../embedding/client';
import { searchChatMessages } from '../embedding/store';

const defaultLimit = 20;
const maxLimit = 50;
const maxRecentMessages = 20;
const maxRecentContextCharacters = 12_000;
const maxHistoryCharacters = 60_000;
const moscowOffsetMilliseconds = 3 * 60 * 60 * 1000;
const semanticSearchThreshold = 0.85;

const historyInputSchema = z.object({
  mode: z.enum(['recent', 'search', 'user_stats']).default('recent'),
  recentMode: z.enum(['missed', 'latest']).default('missed'),
  query: z.string().trim().min(1).optional(),
  sender: z.string().trim().min(1).optional(),
  startAt: z.iso.datetime({ offset: true }).optional(),
  endAt: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
});

export type HistoryMessage = {
  id: string;
  replyToMessageId: string | null;
  senderId: string;
  sender: string;
  sentAt: string;
  type: string;
  content: string;
  similarity?: number;
};

type HistoryRow = {
  id: bigint;
  replyToMessageId: bigint | null;
  senderId: bigint;
  messageType: string;
  sentAt: Date;
  text: string | null;
  summary: string | null;
  searchText: string | null;
  sender: {
    firstName: string | null;
    lastName: string | null;
    userName: string | null;
  };
};

type SenderMatch =
  | { senderId: bigint }
  | { candidates: Array<{ id: string; sender: string }> };

const messageSelect = {
  id: true,
  replyToMessageId: true,
  senderId: true,
  messageType: true,
  sentAt: true,
  text: true,
  summary: true,
  searchText: true,
  sender: {
    select: { firstName: true, lastName: true, userName: true },
  },
} as const;

export function canUseChatHistoryTool(
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

function getContent(row: {
  text: string | null;
  summary: string | null;
  searchText?: string | null;
}): string {
  return (row.summary || row.text || row.searchText || '').trim();
}

function formatMessage(row: HistoryRow, similarity?: number): HistoryMessage {
  return {
    id: row.id.toString(),
    replyToMessageId: row.replyToMessageId?.toString() ?? null,
    senderId: row.senderId.toString(),
    sender: getSenderName(row.sender),
    sentAt: row.sentAt.toISOString(),
    type: row.messageType,
    content: getContent(row),
    ...(similarity === undefined ? {} : { similarity }),
  };
}

async function ensureHistoryAccess(ctx: BotContext): Promise<string | null> {
  if (!ctx.chatId || !ctx.msg || !ctx.chat) {
    return 'Не удалось определить контекст чата';
  }

  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return 'История доступна только в группах';
  }

  const chat = await prisma.chat.findUnique({
    where: { id: BigInt(ctx.chatId) },
    select: { privateModeEnabled: true },
  });
  if (chat?.privateModeEnabled) {
    return 'История недоступна в приватном режиме чата';
  }

  return null;
}

async function resolveSender(
  chatId: bigint,
  sender: string | undefined,
): Promise<SenderMatch | undefined> {
  if (!sender) return undefined;

  const normalized = sender.trim().replace(/^@/, '');
  if (/^\d+$/.test(normalized)) {
    return { senderId: BigInt(normalized) };
  }

  const candidates = await prisma.user.findMany({
    where: {
      Message: {
        some: { chatId, private: false },
      },
      OR: [
        { userName: { equals: normalized, mode: 'insensitive' } },
        { firstName: { contains: normalized, mode: 'insensitive' } },
        { lastName: { contains: normalized, mode: 'insensitive' } },
      ],
    },
    select: { id: true, firstName: true, lastName: true, userName: true },
    take: 10,
  });

  if (candidates.length !== 1) {
    return {
      candidates: candidates.map((candidate) => ({
        id: candidate.id.toString(),
        sender: getSenderName(candidate),
      })),
    };
  }

  return { senderId: candidates[0].id };
}

function createBaseWhere(
  chatId: bigint,
  currentMessageId: bigint,
  startAt: Date | undefined,
  endAt: Date,
  senderId?: bigint,
): Prisma.MessageWhereInput {
  return {
    chatId,
    private: false,
    id: { lt: currentMessageId },
    sentAt: { ...(startAt ? { gte: startAt } : {}), lt: endAt },
    ...(senderId ? { senderId } : {}),
    OR: [{ text: { not: null } }, { summary: { not: null } }],
  };
}

function getTruncatedMessages(
  rows: HistoryRow[],
  limit: number,
  maxCharacters: number,
): { messages: HistoryMessage[]; truncated: boolean } {
  let truncated = rows.length > limit;
  let contextCharacters = 0;
  const messages: HistoryMessage[] = [];

  for (const row of rows.slice(0, limit)) {
    const content = getContent(row);
    if (!content) continue;

    const message = formatMessage(row);
    const messageCharacters = JSON.stringify(message).length;
    if (contextCharacters + messageCharacters > maxCharacters) {
      truncated = true;
      break;
    }

    contextCharacters += messageCharacters;
    messages.push(message);
  }

  return { messages: messages.reverse(), truncated };
}

async function getRecentHistory(
  ctx: BotContext,
  input: z.infer<typeof historyInputSchema>,
): Promise<Record<string, unknown>> {
  const currentMessageId = BigInt(ctx.msg?.message_id ?? 0);
  const currentMessageTime = new Date((ctx.msg?.date ?? 0) * 1000);
  const startAt = parseDate(input.startAt);
  const requestedEndAt = parseDate(input.endAt);
  const endAt =
    requestedEndAt && requestedEndAt < currentMessageTime
      ? requestedEndAt
      : currentMessageTime;
  const usesExplicitRange = Boolean(input.startAt || input.endAt);
  let effectiveStartAt = startAt ?? getMoscowDayStart(currentMessageTime);
  let afterMessageId: bigint | undefined;

  if (
    (input.startAt && !startAt) ||
    (input.endAt && !requestedEndAt) ||
    effectiveStartAt >= endAt
  ) {
    return { error: 'Некорректный интервал времени' };
  }

  try {
    if (!usesExplicitRange && input.recentMode === 'missed') {
      const lastUserMessage = await prisma.message.findFirst({
        where: {
          chatId: BigInt(ctx.chatId ?? 0),
          senderId: BigInt(ctx.from?.id ?? 0),
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
        ...createBaseWhere(
          BigInt(ctx.chatId ?? 0),
          currentMessageId,
          effectiveStartAt,
          endAt,
        ),
        ...(afterMessageId !== undefined
          ? { id: { gt: afterMessageId, lt: currentMessageId } }
          : {}),
      },
      select: messageSelect,
      orderBy: { id: 'desc' },
      take: input.limit + 1,
    });
    const result = getTruncatedMessages(
      rows as HistoryRow[],
      input.limit,
      maxHistoryCharacters,
    );

    return {
      mode: 'recent',
      startAt: effectiveStartAt.toISOString(),
      endAt: endAt.toISOString(),
      totalCount: result.messages.length,
      truncated: result.truncated,
      ...(result.truncated
        ? {
            notice:
              'История усечена. Сообщи, что показана только доступная наиболее свежая часть периода.',
          }
        : {}),
      messages: result.messages,
    };
  } catch (error) {
    logger.error(
      { event: 'chat_history.recent_failed', err: error },
      'search_chat_history recent mode failed',
    );
    return { error: 'Не удалось получить историю сообщений' };
  }
}

async function getUserStats(
  ctx: BotContext,
  input: z.infer<typeof historyInputSchema>,
  senderMatch: SenderMatch | undefined,
): Promise<Record<string, unknown>> {
  if (!senderMatch) {
    return { error: 'Для user_stats нужно указать sender' };
  }
  if ('candidates' in senderMatch) {
    return { candidates: senderMatch.candidates };
  }

  const currentMessageId = BigInt(ctx.msg?.message_id ?? 0);
  const currentMessageTime = new Date((ctx.msg?.date ?? 0) * 1000);
  const startAt = parseDate(input.startAt);
  const requestedEndAt = parseDate(input.endAt);
  const endAt =
    requestedEndAt && requestedEndAt < currentMessageTime
      ? requestedEndAt
      : currentMessageTime;

  if (
    (input.startAt && !startAt) ||
    (input.endAt && !requestedEndAt) ||
    (startAt && startAt >= endAt)
  ) {
    return { error: 'Некорректный интервал времени' };
  }

  try {
    const where = createBaseWhere(
      BigInt(ctx.chatId ?? 0),
      currentMessageId,
      startAt,
      endAt,
      senderMatch.senderId,
    );
    const [totalCount, rows] = await Promise.all([
      prisma.message.count({ where }),
      prisma.message.findMany({
        where,
        select: messageSelect,
        orderBy: { id: 'desc' },
        take: input.limit,
      }),
    ]);

    return {
      mode: 'user_stats',
      totalCount,
      truncated: totalCount > input.limit,
      messages: (rows as HistoryRow[])
        .map((row) => formatMessage(row))
        .reverse(),
    };
  } catch (error) {
    logger.error(
      { event: 'chat_history.user_stats_failed', err: error },
      'search_chat_history user_stats mode failed',
    );
    return { error: 'Не удалось получить сообщения пользователя' };
  }
}

async function searchHistory(
  ctx: BotContext,
  input: z.infer<typeof historyInputSchema>,
  senderMatch: SenderMatch | undefined,
): Promise<Record<string, unknown>> {
  if (!input.query) {
    return { error: 'Для search нужно указать query' };
  }
  if (senderMatch && 'candidates' in senderMatch) {
    return { candidates: senderMatch.candidates };
  }

  const currentMessageId = BigInt(ctx.msg?.message_id ?? 0);
  const currentMessageTime = new Date((ctx.msg?.date ?? 0) * 1000);
  const startAt = parseDate(input.startAt);
  const requestedEndAt = parseDate(input.endAt);
  const endAt =
    requestedEndAt && requestedEndAt < currentMessageTime
      ? requestedEndAt
      : currentMessageTime;

  if (
    (input.startAt && !startAt) ||
    (input.endAt && !requestedEndAt) ||
    (startAt && startAt >= endAt)
  ) {
    return { error: 'Некорректный интервал времени' };
  }

  const where: Prisma.MessageWhereInput = {
    ...createBaseWhere(
      BigInt(ctx.chatId ?? 0),
      currentMessageId,
      startAt,
      endAt,
      senderMatch && 'senderId' in senderMatch
        ? senderMatch.senderId
        : undefined,
    ),
    OR: [
      { text: { contains: input.query, mode: 'insensitive' } },
      { summary: { contains: input.query, mode: 'insensitive' } },
      { searchText: { contains: input.query, mode: 'insensitive' } },
    ],
  };

  try {
    const [exactCount, exactRows] = await Promise.all([
      prisma.message.count({ where }),
      prisma.message.findMany({
        where,
        select: messageSelect,
        orderBy: { id: 'desc' },
        take: input.limit,
      }),
    ]);

    let semanticRows: Array<HistoryRow & { similarity: number }> = [];
    if (input.query.length > 10) {
      try {
        const embedding = await embedQuery(input.query);
        semanticRows = (await searchChatMessages({
          chatId: BigInt(ctx.chatId ?? 0),
          embedding,
          threshold: semanticSearchThreshold,
          limit: input.limit,
          beforeMessageId: currentMessageId,
          senderId:
            senderMatch && 'senderId' in senderMatch
              ? senderMatch.senderId
              : undefined,
          startAt,
          endAt,
        })) as Array<HistoryRow & { similarity: number }>;
      } catch (error) {
        logger.warn(
          { event: 'chat_history.semantic_search_failed', err: error },
          'Semantic chat history search failed',
        );
      }
    }

    const messagesById = new Map<string, HistoryMessage>();
    for (const row of exactRows as HistoryRow[]) {
      messagesById.set(row.id.toString(), formatMessage(row, 1));
    }
    for (const row of semanticRows) {
      if (!messagesById.has(row.id.toString())) {
        messagesById.set(row.id.toString(), formatMessage(row, row.similarity));
      }
    }

    const messages = [...messagesById.values()]
      .sort((left, right) => right.sentAt.localeCompare(left.sentAt))
      .slice(0, input.limit)
      .reverse();
    const truncated =
      exactCount > input.limit || semanticRows.length >= input.limit;

    return {
      mode: 'search',
      query: input.query,
      totalCount: messages.length,
      exactCount,
      truncated,
      ...(truncated ? { notice: 'Поиск ограничен лимитом результатов.' } : {}),
      messages,
    };
  } catch (error) {
    logger.error(
      { event: 'chat_history.search_failed', err: error },
      'search_chat_history search mode failed',
    );
    return { error: 'Не удалось выполнить поиск по истории' };
  }
}

export async function searchChatHistory(
  ctx: BotContext | undefined,
  rawInput: unknown,
): Promise<string> {
  const input = historyInputSchema.safeParse(rawInput);
  if (!input.success) {
    logger.warn(
      { event: 'chat_history.invalid_input' },
      'Invalid search_chat_history input',
    );
    return JSON.stringify({ error: 'Некорректные параметры поиска истории' });
  }
  if (!ctx?.from || !ctx.chatId || !ctx.msg || !ctx.chat) {
    return JSON.stringify({ error: 'Не удалось определить контекст чата' });
  }

  try {
    const accessError = await ensureHistoryAccess(ctx);
    if (accessError) return JSON.stringify({ error: accessError });

    const senderMatch = await resolveSender(
      BigInt(ctx.chatId),
      input.data.sender,
    );
    const result =
      input.data.mode === 'search'
        ? await searchHistory(ctx, input.data, senderMatch)
        : input.data.mode === 'user_stats'
          ? await getUserStats(ctx, input.data, senderMatch)
          : await getRecentHistory(ctx, input.data);

    return JSON.stringify(result);
  } catch (error) {
    logger.error(
      { event: 'chat_history.failed', err: error },
      'search_chat_history failed',
    );
    return JSON.stringify({ error: 'Не удалось получить историю чата' });
  }
}

export async function getRecentPublicChatContext(
  chatId: number,
  currentMessageId: number,
): Promise<{ messages: HistoryMessage[]; truncated: boolean }> {
  try {
    const rows = await prisma.message.findMany({
      where: {
        chatId: BigInt(chatId),
        private: false,
        id: { lt: BigInt(currentMessageId) },
        OR: [{ text: { not: null } }, { summary: { not: null } }],
      },
      select: messageSelect,
      orderBy: { id: 'desc' },
      take: maxRecentMessages,
    });
    return getTruncatedMessages(
      rows as HistoryRow[],
      maxRecentMessages,
      maxRecentContextCharacters,
    );
  } catch (error) {
    logger.warn(
      { event: 'chat_history.recent_context_failed', err: error },
      'Recent public chat context failed',
    );
    return { messages: [], truncated: false };
  }
}

export const createChatHistoryTool = (ctx?: BotContext) =>
  dynamicTool({
    description:
      'Искать историю текущей публичной группы. Используй mode=search для поиска по словам или смыслу, mode=user_stats для количества сообщений пользователя и его последних сообщений, mode=recent для последних сообщений или сценария «что я пропустил». Для поиска пользователя передай sender как @username, имя или Telegram ID. Для периода передай startAt и endAt в ISO 8601 с часовым поясом. В mode=recent без recentMode используй сценарий «что пропустил»: начинай после последнего сообщения пользователя сегодня по Europe/Moscow. Для просто последних сообщений передай recentMode=latest. После tool-call сделай сводку с автором, датой и ID сообщения; если truncated=true, обязательно сообщи об ограничении выборки. Не используй для личных чатов, private-mode или read-only запросов.',
    inputSchema: historyInputSchema,
    execute: (input: unknown) => searchChatHistory(ctx, input),
  });

export { getMoscowDayStart };
