import pgvector from 'pgvector';
import { prisma } from '../db';
import { Prisma } from '../generated/prisma/client';

function toVectorSql(embedding: number[]): string {
  const value = pgvector.toSql(embedding);
  if (!value) throw new Error('Cannot serialize an empty embedding');
  return value;
}

export async function updateMessageEmbeddingRepo(
  chatId: bigint,
  messageId: bigint,
  searchText: string,
  embedding: number[],
  embeddingVersion: number,
): Promise<void> {
  const vector = toVectorSql(embedding);
  await prisma.$executeRaw`
    UPDATE "Message"
    SET "searchText" = ${searchText},
        "embedding" = ${vector}::vector,
        "embeddingVersion" = ${embeddingVersion}
    WHERE "chatId" = ${chatId} AND "id" = ${messageId}
  `;
}

export async function deleteMessageEmbeddingRepo(
  chatId: bigint,
  messageId: bigint,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Message"
    SET "searchText" = NULL,
        "embedding" = NULL,
        "embeddingVersion" = NULL
    WHERE "chatId" = ${chatId} AND "id" = ${messageId}
  `;
}

export async function markMessageEmbeddingSkippedRepo(
  chatId: bigint,
  messageId: bigint,
  version: number,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Message"
    SET "searchText" = NULL,
        "embedding" = NULL,
        "embeddingVersion" = ${version}
    WHERE "chatId" = ${chatId} AND "id" = ${messageId}
  `;
}

export async function searchUserMessageContextRepo(
  userId: bigint,
  embedding: number[],
  threshold: number,
  limit: number,
  version: number,
): Promise<string[]> {
  const vector = toVectorSql(embedding);
  const rows = await prisma.$queryRaw<Array<{ content: string }>>`
    SELECT "searchText" AS content
    FROM "Message"
    WHERE "senderId" = ${userId}
      AND "private" IS NOT TRUE
      AND "embeddingVersion" = ${version}
      AND "embedding" IS NOT NULL
      AND "searchText" IS NOT NULL
      AND 1 - ("embedding" <=> ${vector}::vector) >= ${threshold}
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;
  return rows.map((row) => row.content);
}

export async function searchChatMessageContextRepo(
  chatId: bigint,
  embedding: number[],
  threshold: number,
  limit: number,
  version: number,
): Promise<string[]> {
  const vector = toVectorSql(embedding);
  const rows = await prisma.$queryRaw<Array<{ content: string }>>`
    SELECT "searchText" AS content
    FROM "Message"
    WHERE "chatId" = ${chatId}
      AND "private" IS NOT TRUE
      AND "embeddingVersion" = ${version}
      AND "embedding" IS NOT NULL
      AND "searchText" IS NOT NULL
      AND 1 - ("embedding" <=> ${vector}::vector) >= ${threshold}
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;
  return rows.map((row) => row.content);
}

export interface EmbeddingSearchChatMessage {
  id: bigint;
  replyToMessageId: bigint | null;
  senderId: bigint;
  messageType: string;
  sentAt: Date;
  text: string | null;
  summary: string | null;
  searchText: string | null;
  similarity: number;
  sender: {
    firstName: string | null;
    lastName: string | null;
    userName: string | null;
  };
}

export interface EmbeddingLexicalChatMessage
  extends Omit<EmbeddingSearchChatMessage, 'similarity'> {
  lexicalRank: number;
  exactMatch: boolean;
}

const messageSearchDocument = Prisma.sql`
  coalesce(m."text", '') || ' ' ||
  coalesce(m."summary", '') || ' ' ||
  coalesce(m."searchText", '')
`;

function messageSearchVector() {
  return Prisma.sql`
    to_tsvector('russian'::regconfig, ${messageSearchDocument}) ||
    to_tsvector('english'::regconfig, ${messageSearchDocument})
  `;
}

function messageSearchQuery(query: string) {
  return Prisma.sql`
    websearch_to_tsquery('russian'::regconfig, ${query}) ||
    websearch_to_tsquery('english'::regconfig, ${query})
  `;
}

function broadSearchQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '')}"`)
    .join(' OR ');
}

export async function searchChatMessagesRepo(params: {
  chatId: bigint;
  embedding: number[];
  threshold: number;
  limit: number;
  beforeMessageId?: bigint;
  senderId?: bigint;
  startAt?: Date;
  endAt?: Date;
  version: number;
}): Promise<EmbeddingSearchChatMessage[]> {
  const vector = toVectorSql(params.embedding);
  const conditions = [
    Prisma.sql`m."chatId" = ${params.chatId}`,
    Prisma.sql`m."private" = FALSE`,
    Prisma.sql`m."embeddingVersion" = ${params.version}`,
    Prisma.sql`m."embedding" IS NOT NULL`,
    Prisma.sql`m."searchText" IS NOT NULL`,
    Prisma.sql`1 - (m."embedding" <=> ${vector}::vector) >= ${params.threshold}`,
  ];
  if (params.beforeMessageId !== undefined) {
    conditions.push(Prisma.sql`m."id" < ${params.beforeMessageId}`);
  }
  if (params.senderId !== undefined) {
    conditions.push(Prisma.sql`m."senderId" = ${params.senderId}`);
  }
  if (params.startAt !== undefined) {
    conditions.push(Prisma.sql`m."sentAt" >= ${params.startAt}`);
  }
  if (params.endAt !== undefined) {
    conditions.push(Prisma.sql`m."sentAt" < ${params.endAt}`);
  }
  return prisma.$queryRaw<EmbeddingSearchChatMessage[]>(Prisma.sql`
    SELECT
      m."id", m."replyToMessageId", m."senderId", m."messageType", m."sentAt",
      m."text", m."summary", m."searchText",
      1 - (m."embedding" <=> ${vector}::vector)::float8 AS "similarity",
      json_build_object(
        'firstName', u."firstName",
        'lastName', u."lastName",
        'userName', u."userName"
      ) AS "sender"
    FROM "Message" m
    JOIN "User" u ON u."id" = m."senderId"
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY m."embedding" <=> ${vector}::vector
    LIMIT ${params.limit}
  `);
}

export async function searchChatMessagesLexicalRepo(params: {
  chatId: bigint;
  query: string;
  limit: number;
  beforeMessageId?: bigint;
  senderId?: bigint;
  startAt?: Date;
  endAt?: Date;
}): Promise<EmbeddingLexicalChatMessage[]> {
  const broadQuery = broadSearchQuery(params.query);
  const conditions = [
    Prisma.sql`m."chatId" = ${params.chatId}`,
    Prisma.sql`m."private" = FALSE`,
    Prisma.sql`(m."text" IS NOT NULL OR m."summary" IS NOT NULL OR m."searchText" IS NOT NULL)`,
    Prisma.sql`(${messageSearchVector()}) @@ (${messageSearchQuery(params.query)})`,
  ];
  if (params.beforeMessageId !== undefined) {
    conditions.push(Prisma.sql`m."id" < ${params.beforeMessageId}`);
  }
  if (params.senderId !== undefined) {
    conditions.push(Prisma.sql`m."senderId" = ${params.senderId}`);
  }
  if (params.startAt !== undefined) {
    conditions.push(Prisma.sql`m."sentAt" >= ${params.startAt}`);
  }
  if (params.endAt !== undefined) {
    conditions.push(Prisma.sql`m."sentAt" < ${params.endAt}`);
  }
  return prisma.$queryRaw<EmbeddingLexicalChatMessage[]>(Prisma.sql`
    SELECT
      m."id", m."replyToMessageId", m."senderId", m."messageType", m."sentAt",
      m."text", m."summary", m."searchText",
      GREATEST(
        ts_rank_cd((${messageSearchVector()}), (${messageSearchQuery(params.query)})),
        ts_rank_cd((${messageSearchVector()}), (${messageSearchQuery(broadQuery)})) * 0.75
      )::float8 AS "lexicalRank",
      strpos(lower(${messageSearchDocument}), lower(${params.query})) > 0 AS "exactMatch",
      json_build_object(
        'firstName', u."firstName",
        'lastName', u."lastName",
        'userName', u."userName"
      ) AS "sender"
    FROM "Message" m
    JOIN "User" u ON u."id" = m."senderId"
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY "exactMatch" DESC, "lexicalRank" DESC, m."id" DESC
    LIMIT ${params.limit}
  `);
}

export async function searchSimilarMemoriesVersionedRepo(
  userId: bigint,
  chatId: bigint,
  isUser: boolean,
  embedding: number[],
  threshold: number,
  limit: number,
  version: number,
): Promise<SimilarMemory[]> {
  const vector = toVectorSql(embedding);
  const conditions = [
    Prisma.sql`"embeddingVersion" = ${version}`,
    Prisma.sql`"embedding" IS NOT NULL`,
    Prisma.sql`1 - ("embedding" <=> ${vector}::vector) >= ${threshold}`,
    Prisma.sql`"isUser" = ${isUser}`,
    Prisma.sql`"userId" = ${userId}`,
    ...(isUser ? [] : [Prisma.sql`"chatId" = ${chatId}`]),
  ];
  return prisma.$queryRaw<SimilarMemory[]>(Prisma.sql`
    SELECT "id", "content", 1 - ("embedding" <=> ${vector}::vector) AS similarity
    FROM "Memory"
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `);
}

export async function searchSimilarFactsVersionedRepo(
  userId: bigint,
  embedding: number[],
  threshold: number,
  limit: number,
  version: number,
  type?: string,
): Promise<SimilarFact[]> {
  const vector = toVectorSql(embedding);
  const conditions = [
    Prisma.sql`"userId" = ${userId}`,
    Prisma.sql`"embeddingVersion" = ${version}`,
    Prisma.sql`"embedding" IS NOT NULL`,
    Prisma.sql`1 - ("embedding" <=> ${vector}::vector) >= ${threshold}`,
    ...(type ? [Prisma.sql`"type"::text = ${type}`] : []),
  ];
  return prisma.$queryRaw<SimilarFact[]>(Prisma.sql`
    SELECT "id", "content", 1 - ("embedding" <=> ${vector}::vector) AS similarity
    FROM "UserFact"
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `);
}

export async function updateMemoryEmbeddingRepo(
  memoryId: bigint,
  embedding: number[],
  embeddingVersion: number,
): Promise<void> {
  const vector = toVectorSql(embedding);
  await prisma.$executeRaw`
    UPDATE "Memory"
    SET "embedding" = ${vector}::vector,
        "embeddingVersion" = ${embeddingVersion}
    WHERE "id" = ${memoryId}
  `;
}

export async function updateUserFactEmbeddingRepo(
  factId: bigint,
  embedding: number[],
  embeddingVersion: number,
): Promise<void> {
  const vector = toVectorSql(embedding);
  await prisma.$executeRaw`
    UPDATE "UserFact"
    SET "embedding" = ${vector}::vector,
        "embeddingVersion" = ${embeddingVersion}
    WHERE "id" = ${factId}
  `;
}

export async function searchSimilarUserMessagesRepo(
  userId: bigint,
  embedding: number[],
  limit: number,
): Promise<string[]> {
  const vector = toVectorSql(embedding);
  const rows = await prisma.$queryRaw<Array<{ content: string }>>`
    SELECT "searchText" AS content
    FROM "Message"
    WHERE "senderId" = ${userId}
      AND "private" = FALSE
      AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;
  return rows.map((row) => row.content);
}

export async function searchSimilarChatMessagesRepo(
  chatId: bigint,
  embedding: number[],
  limit: number,
): Promise<string[]> {
  const vector = toVectorSql(embedding);
  const rows = await prisma.$queryRaw<Array<{ content: string }>>`
    SELECT "searchText" AS content
    FROM "Message"
    WHERE "chatId" = ${chatId}
      AND "private" = FALSE
      AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;
  return rows.map((row) => row.content);
}

export interface SimilarChatMessage {
  id: bigint;
  replyToMessageId: bigint | null;
  chatId: bigint;
  senderId: bigint;
  sentAt: Date;
  text: string | null;
  searchText: string | null;
  summary: string | null;
  private: boolean;
  media: string | null;
  messageType: string;
  similarity: number;
}

export async function searchSimilarChatMessagesAdvancedRepo(params: {
  chatId: bigint;
  embedding: number[];
  limit: number;
  userIds?: bigint[];
  startAt?: Date;
  endAt?: Date;
}): Promise<SimilarChatMessage[]> {
  const vector = toVectorSql(params.embedding);
  const conditions: Prisma.Sql[] = [
    Prisma.sql`m."chatId" = ${params.chatId}`,
    Prisma.sql`m."private" = FALSE`,
    Prisma.sql`m."embedding" IS NOT NULL`,
  ];

  if (params.userIds && params.userIds.length > 0) {
    conditions.push(
      Prisma.sql`m."senderId" = ANY(ARRAY[${Prisma.join(params.userIds)}]::BIGINT[])`,
    );
  }

  if (params.startAt) {
    conditions.push(Prisma.sql`m."sentAt" >= ${params.startAt}`);
  }

  if (params.endAt) {
    conditions.push(Prisma.sql`m."sentAt" < ${params.endAt}`);
  }

  return prisma.$queryRaw<SimilarChatMessage[]>(Prisma.sql`
    SELECT
      m."id",
      m."replyToMessageId",
      m."chatId",
      m."senderId",
      m."sentAt",
      m."text",
      m."searchText",
      m."summary",
      m."private",
      m."media",
      m."messageType",
      1 - (m."embedding" <=> ${vector}::vector) AS similarity
    FROM "Message" m
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY m."embedding" <=> ${vector}::vector
    LIMIT ${params.limit}
  `);
}

export interface LexicalChatMessage {
  id: bigint;
  replyToMessageId: bigint | null;
  chatId: bigint;
  senderId: bigint;
  sentAt: Date;
  text: string | null;
  searchText: string | null;
  summary: string | null;
  private: boolean;
  media: string | null;
  messageType: string;
}

export async function searchLexicalChatMessagesRepo(params: {
  chatId: bigint;
  query: string;
  limit: number;
  userIds?: bigint[];
  startAt?: Date;
  endAt?: Date;
}): Promise<LexicalChatMessage[]> {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`m."chatId" = ${params.chatId}`,
    Prisma.sql`m."private" = FALSE`,
    Prisma.sql`m."searchText" IS NOT NULL`,
  ];

  if (params.userIds && params.userIds.length > 0) {
    conditions.push(
      Prisma.sql`m."senderId" = ANY(ARRAY[${Prisma.join(params.userIds)}]::BIGINT[])`,
    );
  }

  if (params.startAt) {
    conditions.push(Prisma.sql`m."sentAt" >= ${params.startAt}`);
  }

  if (params.endAt) {
    conditions.push(Prisma.sql`m."sentAt" < ${params.endAt}`);
  }

  return prisma.$queryRaw<LexicalChatMessage[]>(Prisma.sql`
    SELECT
      m."id",
      m."replyToMessageId",
      m."chatId",
      m."senderId",
      m."sentAt",
      m."text",
      m."searchText",
      m."summary",
      m."private",
      m."media",
      m."messageType"
    FROM "Message" m
    WHERE ${Prisma.join(conditions, ' AND ')}
      AND to_tsvector('russian', m."searchText") @@ websearch_to_tsquery('russian', ${params.query})
    ORDER BY m."id" DESC
    LIMIT ${params.limit}
  `);
}

export interface SimilarMemory {
  id: bigint;
  content: string;
  similarity: number;
}

export async function searchSimilarMemoriesRepo(
  userId: bigint,
  chatId: bigint,
  embedding: number[],
  isUser: boolean,
  limit: number,
): Promise<SimilarMemory[]> {
  const vector = toVectorSql(embedding);
  if (isUser) {
    return prisma.$queryRaw<SimilarMemory[]>`
      SELECT "id", "content", 1 - ("embedding" <=> ${vector}::vector) AS similarity
      FROM "Memory"
      WHERE "isUser" = TRUE
        AND "userId" = ${userId}
        AND "chatId" = ${chatId}
        AND "embedding" IS NOT NULL
      ORDER BY "embedding" <=> ${vector}::vector
      LIMIT ${limit}
    `;
  }

  return prisma.$queryRaw<SimilarMemory[]>`
    SELECT "id", "content", 1 - ("embedding" <=> ${vector}::vector) AS similarity
    FROM "Memory"
    WHERE "isUser" = FALSE
      AND "userId" = ${userId}
      AND "chatId" = ${chatId}
      AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;
}

export interface SimilarFact {
  id: bigint;
  content: string;
  similarity: number;
}

export async function searchSimilarFactsRepo(
  userId: bigint,
  embedding: number[],
  limit: number,
  type?: string,
): Promise<SimilarFact[]> {
  const vector = toVectorSql(embedding);
  if (type) {
    return prisma.$queryRaw<SimilarFact[]>`
      SELECT "id", "content", 1 - ("embedding" <=> ${vector}::vector) AS similarity
      FROM "UserFact"
      WHERE "userId" = ${userId}
        AND "type" = ${type}::text
        AND "embedding" IS NOT NULL
      ORDER BY "embedding" <=> ${vector}::vector
      LIMIT ${limit}
    `;
  }

  return prisma.$queryRaw<SimilarFact[]>`
    SELECT "id", "content", 1 - ("embedding" <=> ${vector}::vector) AS similarity
    FROM "UserFact"
    WHERE "userId" = ${userId}
      AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;
}

export interface ReplyRoot {
  chatId: bigint;
  rootId: bigint;
}

export type ChatHistoryReplyRoot = {
  candidateId: bigint;
  rootMessageId: bigint;
  incomplete: boolean;
};

export async function findReplyRootsRepo(
  candidateIds: bigint[],
  chatId: bigint,
): Promise<ReplyRoot[]> {
  if (candidateIds.length === 0) return [];

  return prisma.$queryRaw<ReplyRoot[]>(Prisma.sql`
    WITH RECURSIVE ancestors AS (
      SELECT
        m."chatId",
        m."id" AS "messageId",
        m."replyToMessageId",
        m."id" AS "rootId"
      FROM "Message" m
      WHERE m."id" = ANY(ARRAY[${Prisma.join(candidateIds)}]::BIGINT[])
        AND m."chatId" = ${chatId}

      UNION ALL

      SELECT
        m."chatId",
        m."id" AS "messageId",
        m."replyToMessageId",
        a."rootId"
      FROM "Message" m
        INNER JOIN ancestors a ON m."id" = a."replyToMessageId" AND m."chatId" = a."chatId"
    )
    SELECT DISTINCT ON (a."rootId")
      a."chatId",
      a."rootId"
    FROM ancestors a
    WHERE a."replyToMessageId" IS NULL
  `);
}

export async function findChatHistoryReplyRootsRepo(
  chatId: bigint,
  currentMessageId: bigint,
  candidateIds: bigint[],
): Promise<ChatHistoryReplyRoot[]> {
  if (candidateIds.length === 0) return [];

  return prisma.$queryRaw<ChatHistoryReplyRoot[]>`
    WITH RECURSIVE ancestors AS (
      SELECT
        m."chatId",
        m."id" AS "candidateId",
        m."id",
        m."replyToMessageId",
        ARRAY[m."id"]::bigint[] AS path,
        FALSE AS incomplete
      FROM "Message" m
      WHERE m."chatId" = ${chatId}
        AND m."private" = FALSE
        AND m."id" < ${currentMessageId}
        AND m."id" = ANY(${candidateIds})

      UNION ALL

      SELECT
        a."chatId",
        a."candidateId",
        parent."id",
        parent."replyToMessageId",
        a.path || parent."id",
        a.incomplete OR (parent."id" IS NULL)
      FROM ancestors a
      LEFT JOIN "Message" parent
        ON parent."chatId" = a."chatId"
        AND parent."id" = a."replyToMessageId"
        AND parent."private" = FALSE
        AND parent."id" < ${currentMessageId}
      WHERE a."replyToMessageId" IS NOT NULL
        AND NOT (parent."id" = ANY(a.path))
        AND array_length(a.path, 1) < 50
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
  `;
}

export interface ReplyGraphRow {
  id: bigint;
  replyToMessageId: bigint | null;
  senderId: bigint;
  sentAt: Date;
  searchText: string | null;
}

export async function fetchReplyGraphRepo(
  rootIds: bigint[],
  chatId: bigint,
): Promise<ReplyGraphRow[]> {
  if (rootIds.length === 0) return [];

  return prisma.$queryRaw<ReplyGraphRow[]>(Prisma.sql`
    WITH RECURSIVE reply_tree AS (
      SELECT
        m."id",
        m."replyToMessageId",
        m."senderId",
        m."sentAt",
        m."searchText"
      FROM "Message" m
      WHERE m."id" = ANY(ARRAY[${Prisma.join(rootIds)}]::BIGINT[])
        AND m."chatId" = ${chatId}
        AND m."private" = FALSE

      UNION ALL

      SELECT
        m."id",
        m."replyToMessageId",
        m."senderId",
        m."sentAt",
        m."searchText"
      FROM "Message" m
        INNER JOIN reply_tree rt ON m."replyToMessageId" = rt."id"
      WHERE m."chatId" = ${chatId}
        AND m."private" = FALSE
    )
    SELECT * FROM reply_tree
  `);
}

export type ChatHistoryReplyGraphRow = {
  id: bigint;
  chatId: bigint;
  senderId: bigint;
  sessionId: string | null;
  replyToMessageId: bigint | null;
  messageType: string;
  text: string | null;
  media: string | null;
  summary: string | null;
  searchText: string | null;
  private: boolean;
  sentAt: Date;
  rootMessageId: bigint;
  depth: number;
  senderFirstName: string | null;
  senderLastName: string | null;
  senderUserName: string | null;
};

export async function fetchChatHistoryReplyGraphRepo(
  chatId: bigint,
  rootIds: bigint[],
  currentMessageId: bigint,
): Promise<ChatHistoryReplyGraphRow[]> {
  if (rootIds.length === 0) return [];

  return prisma.$queryRaw<ChatHistoryReplyGraphRow[]>`
    WITH RECURSIVE reply_tree AS (
      SELECT
        m."id",
        m."chatId",
        m."replyToMessageId",
        m."senderId",
        m."sessionId",
        m."messageType",
        m."text",
        m."summary",
        m."searchText",
        m."sentAt",
        m."private",
        m."media",
        m."id" AS "rootMessageId",
        0::int AS depth,
        ARRAY[m."id"]::bigint[] AS path
      FROM "Message" m
      WHERE m."chatId" = ${chatId}
        AND m."private" = FALSE
        AND m."id" < ${currentMessageId}
        AND m."id" = ANY(${rootIds})

      UNION ALL

      SELECT
        child."id",
        child."chatId",
        child."replyToMessageId",
        child."senderId",
        child."sessionId",
        child."messageType",
        child."text",
        child."summary",
        child."searchText",
        child."sentAt",
        child."private",
        child."media",
        rt."rootMessageId",
        rt.depth + 1,
        rt.path || child."id"
      FROM reply_tree rt
      JOIN "Message" child
        ON child."chatId" = rt."chatId"
        AND child."replyToMessageId" = rt."id"
        AND child."private" = FALSE
        AND child."id" < ${currentMessageId}
        AND NOT (child."id" = ANY(rt.path))
        AND rt.depth < 50
    )
    SELECT
      rt.id,
      rt."chatId",
      rt."senderId",
      rt."sessionId",
      rt."replyToMessageId",
      rt."messageType",
      rt.text,
      rt.summary,
      rt."searchText",
      rt.private,
      rt.media,
      rt."sentAt",
      rt."rootMessageId",
      rt.depth,
      u."firstName" AS "senderFirstName",
      u."lastName" AS "senderLastName",
      u."userName" AS "senderUserName"
    FROM reply_tree rt
    LEFT JOIN "User" u ON u."id" = rt."senderId"
    ORDER BY rt."rootMessageId", rt.depth, rt."sentAt"
  `;
}

export async function healthCheckRepo(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

function outdatedEmbeddingWhere(version: number) {
  return {
    OR: [{ embeddingVersion: null }, { embeddingVersion: { not: version } }],
  };
}

export function findMessagesForEmbeddingBackfillRepo(
  version: number,
  take: number,
) {
  return prisma.message.findMany({
    where: {
      AND: [
        outdatedEmbeddingWhere(version),
        { OR: [{ private: false }, { private: null }] },
      ],
    },
    include: { replyToMessage: { select: { text: true, summary: true } } },
    orderBy: [{ sentAt: 'asc' }, { chatId: 'asc' }, { id: 'asc' }],
    take,
  });
}

export function findMemoriesForEmbeddingBackfillRepo(
  version: number,
  take: number,
) {
  return prisma.memory.findMany({
    where: outdatedEmbeddingWhere(version),
    orderBy: { id: 'asc' },
    take,
  });
}

export function findFactsForEmbeddingBackfillRepo(
  version: number,
  take: number,
) {
  return prisma.userFact.findMany({
    where: outdatedEmbeddingWhere(version),
    orderBy: { id: 'asc' },
    take,
  });
}

export function countEmbeddingBacklogRepo(version: number) {
  const where = outdatedEmbeddingWhere(version);
  return Promise.all([
    prisma.message.count({
      where: {
        AND: [where, { OR: [{ private: false }, { private: null }] }],
      },
    }),
    prisma.memory.count({ where }),
    prisma.userFact.count({ where }),
  ]);
}
