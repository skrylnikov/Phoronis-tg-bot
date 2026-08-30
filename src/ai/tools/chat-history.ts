import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { BotContext } from '../../bot';
import type { Prisma } from '../../generated/prisma/client';
import { logger } from '../../logger';
import {
  type ChatHistoryReplyGraphRow,
  fetchChatHistoryReplyGraphRepo,
  findChatHistoryReplyRootsRepo,
} from '../../repositories/embedding-repository';
import {
  countMessagesRepo,
  findFirstMessageRepo,
  findManyMessagesRepo,
} from '../../repositories/message-repository';
import { findManyUsersRepo } from '../../repositories/user-repository';
import { embedQuery } from '../embedding/client';
import {
  searchChatMessages,
  searchChatMessagesLexical,
} from '../embedding/store';
import { isGenericHistorySearchRequest } from '../history-intent';

const defaultLimit = 20;
const maxLimit = 50;
const defaultSearchThreads = 5;
const maxSearchThreads = 10;
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
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(maxLimit)
    .optional()
    .describe(
      'Для search — количество тредов (по умолчанию 5, максимум 10); для recent и user_stats — количество сообщений (по умолчанию 20).',
    ),
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
    (ctx?.chat?.type === 'private' ||
      ctx?.chat?.type === 'group' ||
      ctx?.chat?.type === 'supergroup')
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

async function resolveSearchQuery(
  ctx: BotContext,
  query: string,
): Promise<string> {
  if (!isGenericHistorySearchRequest(query)) return query;

  const repliedMessage = ctx.msg?.reply_to_message;
  const replyText = (
    repliedMessage?.text ??
    repliedMessage?.caption ??
    ''
  ).trim();
  const repliedMessageId = repliedMessage?.message_id;

  if (ctx.chatId && repliedMessageId !== undefined) {
    try {
      const botMessage = await findFirstMessageRepo(
        {
          chatId: BigInt(ctx.chatId),
          id: BigInt(repliedMessageId),
          private: false,
        },
        {
          select: {
            replyToMessageId: true,
            text: true,
            summary: true,
            searchText: true,
          },
        },
      );

      if (botMessage?.replyToMessageId) {
        const originalMessage = await findFirstMessageRepo(
          {
            chatId: BigInt(ctx.chatId),
            id: botMessage.replyToMessageId,
            private: false,
          },
          {
            select: { text: true, summary: true, searchText: true },
          },
        );
        const originalQuery = originalMessage
          ? getContent(originalMessage)
          : '';
        if (originalQuery) return originalQuery;
      }
    } catch (error) {
      logger.warn(
        { event: 'chat_history.resolve_search_query_failed', err: error },
        'Failed to resolve the original history search query',
      );
    }
  }

  return replyText || query;
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
): Promise<
  Array<{ candidateId: bigint; rootMessageId: bigint; incomplete: boolean }>
> {
  if (candidateIds.length === 0) return [];
  return findChatHistoryReplyRootsRepo(chatId, currentMessageId, candidateIds);
}

async function loadReplyGraphRows(
  chatId: bigint,
  rootIds: bigint[],
  currentMessageId: bigint,
): Promise<Array<HistoryRow & { rootMessageId: bigint; depth: number }>> {
  if (rootIds.length === 0) return [];
  const rows: ChatHistoryReplyGraphRow[] = await fetchChatHistoryReplyGraphRepo(
    chatId,
    rootIds,
    currentMessageId,
  );
  return rows.map(
    (r: ChatHistoryReplyGraphRow) =>
      ({
        id: r.id,
        senderId: r.senderId,
        replyToMessageId: r.replyToMessageId,
        messageType: r.messageType,
        text: r.text,
        summary: r.summary,
        searchText: r.searchText,
        sentAt: r.sentAt,
        sender: {
          firstName: r.senderFirstName,
          lastName: r.senderLastName,
          userName: r.senderUserName,
        },
        rootMessageId: r.rootMessageId,
        depth: r.depth,
      }) as HistoryRow & { rootMessageId: bigint; depth: number },
  );
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
  rootsByCandidate: Map<
    string,
    { candidateId: bigint; rootMessageId: bigint; incomplete: boolean }
  >;
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
  const rows = await loadReplyGraphRows(chatId, rootIds, currentMessageId);
  const rowsByRoot = new Map<string, HistoryRow[]>();

  for (const row of rows) {
    const rootId =
      'rootMessageId' in row && typeof row.rootMessageId === 'bigint'
        ? row.rootMessageId.toString()
        : row.id.toString();
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

  const candidates = await findManyUsersRepo(
    {
      Message: {
        some: { chatId, private: false },
      },
      OR: [
        { userName: { equals: normalized, mode: 'insensitive' } },
        { firstName: { contains: normalized, mode: 'insensitive' } },
        { lastName: { contains: normalized, mode: 'insensitive' } },
      ],
    },
    {
      select: { id: true, firstName: true, lastName: true, userName: true },
    },
  ).then((users) => users.slice(0, 10));

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
    sentAt: {
      ...(startAt ? { gte: startAt } : {}),
      ...(endAt ? { lt: endAt } : {}),
    },
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
  const limit = input.limit ?? defaultLimit;
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
      const lastUserMessage = await findFirstMessageRepo(
        {
          chatId: BigInt(ctx.chatId ?? 0),
          senderId: BigInt(ctx.from?.id ?? 0),
          private: false,
          id: { lt: currentMessageId },
          sentAt: { gte: effectiveStartAt, lt: endAt },
        },
        {
          orderBy: { id: 'desc' },
          select: { id: true, sentAt: true },
        },
      );

      if (lastUserMessage) {
        effectiveStartAt = lastUserMessage.sentAt;
        afterMessageId = lastUserMessage.id;
      }
    }

    const rows = await findManyMessagesRepo(
      {
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
      {
        select: messageSelect,
        orderBy: { id: 'desc' },
        take: limit + 1,
      },
    );
    const result = getTruncatedMessages(
      rows as unknown as HistoryRow[],
      limit,
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
  const limit = input.limit ?? defaultLimit;
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
      countMessagesRepo(where),
      findManyMessagesRepo(where, {
        select: messageSelect,
        orderBy: { id: 'desc' },
        take: limit,
      }),
    ]);

    return {
      mode: 'user_stats',
      totalCount,
      truncated: totalCount > limit,
      messages: (rows as unknown as HistoryRow[])
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

  const searchQuery = await resolveSearchQuery(ctx, input.query);

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
      { text: { contains: searchQuery, mode: 'insensitive' } },
      { summary: { contains: searchQuery, mode: 'insensitive' } },
      { searchText: { contains: searchQuery, mode: 'insensitive' } },
    ],
  };

  try {
    const [exactCount, exactRows] = await Promise.all([
      countMessagesRepo(where),
      findManyMessagesRepo(where, {
        select: messageSelect,
        orderBy: { id: 'desc' },
        take: searchCandidateLimit,
      }),
    ]);

    let lexicalRows: Awaited<ReturnType<typeof searchChatMessagesLexical>> = [];
    try {
      lexicalRows = await searchChatMessagesLexical({
        chatId: BigInt(ctx.chatId ?? 0),
        query: searchQuery,
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
    if (searchQuery.length > 10) {
      try {
        const embedding = await embedQuery(searchQuery);
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
    for (const [index, row] of (
      exactRows as unknown as HistoryRow[]
    ).entries()) {
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
      Math.min(input.limit ?? defaultSearchThreads, maxSearchThreads),
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

    const threadReferences = threads.map((thread, index) => ({
      number: index + 1,
      rootMessageId: thread.rootMessageId,
      matchedMessageId: thread.matchedMessageId,
      ...(thread.rootLink ? { rootLink: thread.rootLink } : {}),
      ...(thread.matchedMessageLink
        ? { matchedMessageLink: thread.matchedMessageLink }
        : {}),
    }));

    return {
      mode: 'search',
      query: input.query,
      ...(searchQuery !== input.query ? { searchQuery } : {}),
      totalCount: threads.length,
      exactCount,
      truncated,
      ...(truncated ? { notice: 'Поиск ограничен лимитом результатов.' } : {}),
      threadReferences,
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
    const rows = await findManyMessagesRepo(
      {
        chatId: BigInt(chatId),
        private: false,
        id: { lt: BigInt(currentMessageId) },
        OR: [{ text: { not: null } }, { summary: { not: null } }],
      },
      {
        select: messageSelect,
        orderBy: { id: 'desc' },
        take: maxRecentMessages,
      },
    );
    return getTruncatedMessages(
      rows as unknown as HistoryRow[],
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
      'Искать публичную историю текущего чата. Если пользователь спрашивает о прошлых сообщениях, обсуждениях, датах или участниках, сначала обязательно вызови этот tool, а не отвечай по общему контексту. Используй mode=search для поиска по словам или смыслу: он возвращает до десяти разных reply-тредов, собранных целиком из доступных сообщений. Параметр limit в mode=search задаёт число тредов (по умолчанию 5, максимум 10); увеличивай его, если пользователь просит найти больше вариантов. Поиск поддерживает русский и английский стемминг; если термин может быть русской транслитерацией английского слова, передай оба варианта через пробел, например «раст Rust». Если пользователь пишет короткий follow-up вроде «поищи по чату» в reply на ответ бота, используй тему исходного вопроса; tool также восстановит её автоматически из связанного сообщения. После tool-call в ответе обязательно сделай отдельный пронумерованный пункт для каждого элемента threads/threadReferences: число пунктов и ссылок должно совпадать с totalCount. Для каждого треда кратко суммируй содержание, объясни релевантность, дай rootLink на начало обсуждения и matchedMessageLink на найденное сообщение; не заменяй несколько тредов одной ссылкой и не придумывай ссылки. Если incomplete=true или truncated=true, обязательно сообщи, что доступна не вся ветка. Используй mode=user_stats для количества сообщений пользователя и его последних сообщений, mode=recent для последних сообщений или сценария «что я пропустил». Для поиска пользователя передай sender как @username, имя или Telegram ID. Для периода передай startAt и endAt в ISO 8601 с часовым поясом. В mode=recent без recentMode используй сценарий «что пропустил»: начинай после последнего сообщения пользователя сегодня по Europe/Moscow. Для просто последних сообщений передай recentMode=latest. После tool-call для recent/user_stats сделай сводку с автором, датой и ID сообщения. Не используй в read-only запросах.',
    inputSchema: historyInputSchema,
    execute: (input: unknown) => searchChatHistory(ctx, input),
  });

export { getMoscowDayStart };
