import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { BotContext } from '../../bot';
import { prisma } from '../../db';
import { Prisma } from '../../generated/prisma/client';
import { logger } from '../../logger';
import { embedQuery } from '../embedding/client';
import {
  searchChatMessages,
  searchChatMessagesLexical,
} from '../embedding/store';

const defaultLimit = 20;
const maxLimit = 50;
const maxSearchThreads = 5;
const searchCandidateLimit = 40;
const reciprocalRankConstant = 60;
const exactMatchBoost = 0.02;
const maxThreadMessages = 40;
const maxThreadCharacters = 10_000;
const maxSearchCharacters = 50_000;
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

export type HistoryThread = {
  rootMessageId: string;
  matchedMessageId: string;
  rootLink?: string;
  matchedMessageLink?: string;
  branchCount: number;
  incomplete: boolean;
  truncated: boolean;
  messages: HistoryMessage[];
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

type ReplyGraphRow = HistoryRow & {
  rootMessageId: bigint;
  depth: number;
};

type ReplyRoot = {
  candidateId: bigint;
  rootMessageId: bigint;
  incomplete: boolean;
};

type SearchCandidate = {
  row: HistoryRow;
  score: number;
  exactMatch: boolean;
  semanticSimilarity?: number;
};

type ReplyGraph = {
  rootMessageId: bigint;
  rows: HistoryRow[];
  branchCount: number;
  incomplete: boolean;
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

export function buildMessageLink(
  ctx: BotContext,
  messageId: bigint,
): string | undefined {
  const chat = ctx.chat;
  if (chat?.type !== 'supergroup') return undefined;

  if (chat.username) {
    return `https://t.me/${chat.username}/${messageId.toString()}`;
  }

  const chatId = (ctx.chatId ?? chat.id).toString();
  if (!chatId.startsWith('-100')) return undefined;

  const channelId = chatId.slice(4);
  return channelId
    ? `https://t.me/c/${channelId}/${messageId.toString()}`
    : undefined;
}

async function resolveReplyRoots(
  chatId: bigint,
  currentMessageId: bigint,
  candidateIds: bigint[],
): Promise<ReplyRoot[]> {
  if (candidateIds.length === 0) return [];

  return prisma.$queryRaw<ReplyRoot[]>(Prisma.sql`
    WITH RECURSIVE ancestors AS (
      SELECT
        m."chatId",
        m."id" AS "candidateId",
        m."id",
        m."replyToMessageId",
        ARRAY[m."id"]::bigint[] AS path
      FROM "Message" m
      WHERE m."chatId" = ${chatId}
        AND m."private" = FALSE
        AND m."id" < ${currentMessageId}
        AND m."id" IN (${Prisma.join(candidateIds)})

      UNION ALL

      SELECT
        a."chatId",
        a."candidateId",
        parent."id",
        parent."replyToMessageId",
        a.path || parent."id"
      FROM ancestors a
      JOIN "Message" parent
        ON parent."chatId" = a."chatId"
       AND parent."id" = a."replyToMessageId"
      WHERE parent."private" = FALSE
        AND parent."id" < ${currentMessageId}
        AND NOT (parent."id" = ANY(a.path))
    ),
    root_candidates AS (
      SELECT
        a."candidateId",
        a."id" AS "rootMessageId",
        (
          a."replyToMessageId" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "Message" parent
            WHERE parent."chatId" = a."chatId"
              AND parent."id" = a."replyToMessageId"
              AND parent."private" = FALSE
              AND parent."id" < ${currentMessageId}
          )
        ) AS incomplete,
        cardinality(a.path) AS depth
      FROM ancestors a
      WHERE a."replyToMessageId" IS NULL
         OR NOT EXISTS (
              SELECT 1
              FROM "Message" parent
              WHERE parent."chatId" = a."chatId"
                AND parent."id" = a."replyToMessageId"
                AND parent."private" = FALSE
                AND parent."id" < ${currentMessageId}
            )
    ),
    ranked_roots AS (
      SELECT
        r."candidateId",
        r."rootMessageId",
        r.incomplete,
        row_number() OVER (
          PARTITION BY r."candidateId"
          ORDER BY r.depth DESC
        ) AS root_rank
      FROM root_candidates r
    ),
    fallback_roots AS (
      SELECT DISTINCT ON (a."candidateId")
        a."candidateId",
        a."id" AS "rootMessageId",
        TRUE AS incomplete
      FROM ancestors a
      WHERE NOT EXISTS (
        SELECT 1
        FROM root_candidates r
        WHERE r."candidateId" = a."candidateId"
      )
      ORDER BY a."candidateId", cardinality(a.path) DESC
    )
    SELECT "candidateId", "rootMessageId", incomplete
    FROM ranked_roots
    WHERE root_rank = 1
    UNION ALL
    SELECT "candidateId", "rootMessageId", incomplete
    FROM fallback_roots
  `);
}

async function loadReplyGraphRows(
  chatId: bigint,
  currentMessageId: bigint,
  rootIds: bigint[],
): Promise<ReplyGraphRow[]> {
  if (rootIds.length === 0) return [];

  return prisma.$queryRaw<ReplyGraphRow[]>(Prisma.sql`
    WITH RECURSIVE reply_tree AS (
      SELECT
        m."id",
        m."chatId",
        m."replyToMessageId",
        m."senderId",
        m."messageType",
        m."text",
        m."summary",
        m."searchText",
        m."sentAt",
        m."id" AS "rootMessageId",
        0::int AS depth,
        ARRAY[m."id"]::bigint[] AS path
      FROM "Message" m
      WHERE m."chatId" = ${chatId}
        AND m."private" = FALSE
        AND m."id" < ${currentMessageId}
        AND m."id" IN (${Prisma.join(rootIds)})

      UNION ALL

      SELECT
        child."id",
        child."chatId",
        child."replyToMessageId",
        child."senderId",
        child."messageType",
        child."text",
        child."summary",
        child."searchText",
        child."sentAt",
        tree."rootMessageId",
        tree.depth + 1,
        tree.path || child."id"
      FROM reply_tree tree
      JOIN "Message" child
        ON child."chatId" = tree."chatId"
       AND child."replyToMessageId" = tree."id"
      WHERE child."private" = FALSE
        AND child."id" < ${currentMessageId}
        AND NOT (child."id" = ANY(tree.path))
    )
    SELECT
      tree."id",
      tree."replyToMessageId",
      tree."senderId",
      tree."messageType",
      tree."sentAt",
      tree."text",
      tree."summary",
      tree."searchText",
      tree."rootMessageId",
      tree.depth,
      json_build_object(
        'firstName', u."firstName",
        'lastName', u."lastName",
        'userName', u."userName"
      ) AS "sender"
    FROM reply_tree tree
    JOIN "User" u ON u."id" = tree."senderId"
    ORDER BY tree."rootMessageId", tree."sentAt", tree."id"
  `);
}

function countReplyBranches(rows: HistoryRow[]): number {
  const parentIds = new Set(
    rows
      .map((row) => row.replyToMessageId?.toString())
      .filter((id): id is string => id !== undefined),
  );
  const leaves = rows.filter((row) => !parentIds.has(row.id.toString()));
  return Math.max(leaves.length, 1);
}

async function loadReplyGraphs(
  chatId: bigint,
  currentMessageId: bigint,
  candidateIds: bigint[],
): Promise<{
  graphs: Map<string, ReplyGraph>;
  rootsByCandidate: Map<string, ReplyRoot>;
}> {
  const roots = await resolveReplyRoots(chatId, currentMessageId, candidateIds);
  const rootsByCandidate = new Map(
    roots.map((root) => [root.candidateId.toString(), root]),
  );
  const rootIds = [
    ...new Map(
      roots.map((root) => [root.rootMessageId.toString(), root.rootMessageId]),
    ).values(),
  ];
  const rows = await loadReplyGraphRows(chatId, currentMessageId, rootIds);
  const rowsByRoot = new Map<string, HistoryRow[]>();

  for (const row of rows) {
    const rootId = row.rootMessageId.toString();
    const rootRows = rowsByRoot.get(rootId) ?? [];
    rootRows.push(row);
    rowsByRoot.set(rootId, rootRows);
  }

  const incompleteByRoot = new Map<string, boolean>();
  for (const root of roots) {
    const rootId = root.rootMessageId.toString();
    incompleteByRoot.set(
      rootId,
      (incompleteByRoot.get(rootId) ?? false) || root.incomplete,
    );
  }

  const graphs = new Map<string, ReplyGraph>();
  for (const [rootId, rootRows] of rowsByRoot) {
    rootRows.sort(
      (left, right) =>
        left.sentAt.getTime() - right.sentAt.getTime() ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    graphs.set(rootId, {
      rootMessageId: BigInt(rootId),
      rows: rootRows,
      branchCount: countReplyBranches(rootRows),
      incomplete: incompleteByRoot.get(rootId) ?? false,
    });
  }

  return { graphs, rootsByCandidate };
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

function addSearchCandidate(
  candidates: Map<string, SearchCandidate>,
  row: HistoryRow,
  rank: number,
  options: {
    exactMatch?: boolean;
    semanticSimilarity?: number;
  } = {},
): void {
  const id = row.id.toString();
  const candidate = candidates.get(id) ?? {
    row,
    score: 0,
    exactMatch: false,
  };

  candidate.score += 1 / (reciprocalRankConstant + rank);
  const wasExactMatch = candidate.exactMatch;
  candidate.exactMatch ||= options.exactMatch ?? false;
  if (!wasExactMatch && candidate.exactMatch) {
    candidate.score += exactMatchBoost;
  }
  if (
    options.semanticSimilarity !== undefined &&
    (candidate.semanticSimilarity === undefined ||
      options.semanticSimilarity > candidate.semanticSimilarity)
  ) {
    candidate.semanticSimilarity = options.semanticSimilarity;
  }
  candidates.set(id, candidate);
}

function getBoundedThreadMessages(
  rows: HistoryRow[],
  matchedMessageId: bigint,
  semanticSimilarity: number | undefined,
): { messages: HistoryMessage[]; truncated: boolean } {
  let characters = 0;
  let truncated = rows.length > maxThreadMessages;
  const messages: HistoryMessage[] = [];

  for (const row of rows) {
    if (messages.length >= maxThreadMessages) {
      truncated = true;
      break;
    }

    const content = getContent(row);
    if (!content) continue;

    const message = formatMessage(
      row,
      row.id === matchedMessageId ? semanticSimilarity : undefined,
    );
    const messageCharacters = JSON.stringify(message).length;
    if (characters + messageCharacters > maxThreadCharacters) {
      truncated = true;
      break;
    }

    characters += messageCharacters;
    messages.push(message);
  }

  return { messages, truncated };
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
        take: searchCandidateLimit,
      }),
    ]);

    let lexicalRows: Awaited<ReturnType<typeof searchChatMessagesLexical>> = [];
    try {
      lexicalRows = await searchChatMessagesLexical({
        chatId: BigInt(ctx.chatId ?? 0),
        query: input.query,
        limit: searchCandidateLimit,
        beforeMessageId: currentMessageId,
        senderId:
          senderMatch && 'senderId' in senderMatch
            ? senderMatch.senderId
            : undefined,
        startAt,
        endAt,
      });
    } catch (error) {
      logger.warn(
        { event: 'chat_history.lexical_search_failed', err: error },
        'Lexical chat history search failed',
      );
    }

    let semanticRows: Array<HistoryRow & { similarity: number }> = [];
    if (input.query.length > 10) {
      try {
        const embedding = await embedQuery(input.query);
        semanticRows = (await searchChatMessages({
          chatId: BigInt(ctx.chatId ?? 0),
          embedding,
          threshold: semanticSearchThreshold,
          limit: searchCandidateLimit,
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

    const candidates = new Map<string, SearchCandidate>();
    for (const [index, row] of (exactRows as HistoryRow[]).entries()) {
      addSearchCandidate(candidates, row, index + 1, { exactMatch: true });
    }
    for (const [index, row] of lexicalRows.entries()) {
      addSearchCandidate(candidates, row, index + 1, {
        exactMatch: row.exactMatch,
      });
    }
    for (const [index, row] of semanticRows.entries()) {
      addSearchCandidate(candidates, row, index + 1, {
        semanticSimilarity: row.similarity,
      });
    }

    const rankedCandidates = [...candidates.values()].sort(
      (left, right) =>
        right.score - left.score ||
        right.row.sentAt.getTime() - left.row.sentAt.getTime() ||
        (right.row.id < left.row.id ? -1 : right.row.id > left.row.id ? 1 : 0),
    );
    const { graphs, rootsByCandidate } = await loadReplyGraphs(
      BigInt(ctx.chatId ?? 0),
      currentMessageId,
      rankedCandidates.map((candidate) => candidate.row.id),
    );

    const bestCandidateByRoot = new Map<
      string,
      { candidate: SearchCandidate; graph: ReplyGraph }
    >();
    for (const candidate of rankedCandidates) {
      const root = rootsByCandidate.get(candidate.row.id.toString());
      if (!root) continue;

      const graph = graphs.get(root.rootMessageId.toString());
      if (!graph) continue;

      const rootId = graph.rootMessageId.toString();
      if (!bestCandidateByRoot.has(rootId)) {
        bestCandidateByRoot.set(rootId, { candidate, graph });
      }
    }

    const selectedThreads = [...bestCandidateByRoot.values()].slice(
      0,
      Math.min(input.limit, maxSearchThreads),
    );
    const threads: HistoryThread[] = [];
    let totalThreadCharacters = 0;
    let globalTruncated = bestCandidateByRoot.size > selectedThreads.length;

    for (const { candidate, graph } of selectedThreads) {
      const bounded = getBoundedThreadMessages(
        graph.rows,
        candidate.row.id,
        candidate.semanticSimilarity,
      );
      const threadCharacters = JSON.stringify(bounded.messages).length;
      if (
        threads.length > 0 &&
        totalThreadCharacters + threadCharacters > maxSearchCharacters
      ) {
        globalTruncated = true;
        break;
      }

      totalThreadCharacters += threadCharacters;
      threads.push({
        rootMessageId: graph.rootMessageId.toString(),
        matchedMessageId: candidate.row.id.toString(),
        rootLink: buildMessageLink(ctx, graph.rootMessageId),
        matchedMessageLink: buildMessageLink(ctx, candidate.row.id),
        branchCount: graph.branchCount,
        incomplete: graph.incomplete,
        truncated: bounded.truncated,
        messages: bounded.messages,
      });
    }

    const truncated =
      globalTruncated ||
      threads.some((thread) => thread.truncated === true) ||
      exactCount > searchCandidateLimit ||
      lexicalRows.length >= searchCandidateLimit ||
      semanticRows.length >= searchCandidateLimit;

    return {
      mode: 'search',
      query: input.query,
      totalCount: threads.length,
      exactCount,
      truncated,
      ...(truncated ? { notice: 'Поиск ограничен лимитом результатов.' } : {}),
      threads,
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
      'Искать историю текущей публичной группы. Используй mode=search для поиска по словам или смыслу: он возвращает до пяти разных reply-тредов, собранных целиком из доступных сообщений. После tool-call кратко суммируй каждый тред, объясни релевантность и используй rootLink для начала обсуждения и matchedMessageLink для найденного сообщения; не придумывай ссылки. Если incomplete=true или truncated=true, обязательно сообщи, что доступна не вся ветка. Используй mode=user_stats для количества сообщений пользователя и его последних сообщений, mode=recent для последних сообщений или сценария «что я пропустил». Для поиска пользователя передай sender как @username, имя или Telegram ID. Для периода передай startAt и endAt в ISO 8601 с часовым поясом. В mode=recent без recentMode используй сценарий «что пропустил»: начинай после последнего сообщения пользователя сегодня по Europe/Moscow. Для просто последних сообщений передай recentMode=latest. После tool-call для recent/user_stats сделай сводку с автором, датой и ID сообщения. Не используй для личных чатов, private-mode или read-only запросов.',
    inputSchema: historyInputSchema,
    execute: (input: unknown) => searchChatHistory(ctx, input),
  });

export { getMoscowDayStart };
