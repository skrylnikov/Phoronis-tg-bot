import { prisma } from '../db';
import { Prisma } from '../generated/prisma/client';

function toVectorSql(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
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

export interface ChatHistoryReplyRoot {
  candidateId: bigint;
  rootMessageId: bigint;
  incomplete: boolean;
}

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

export interface ReplyGraphRow {
  id: bigint;
  replyToMessageId: bigint | null;
  senderId: bigint;
  sentAt: Date;
  searchText: string | null;
}

export interface ChatHistoryReplyGraphRow {
  id: bigint;
  replyToMessageId: bigint | null;
  senderId: bigint;
  messageType: string;
  text: string | null;
  summary: string | null;
  searchText: string | null;
  sentAt: Date;
  rootMessageId: bigint;
  depth: number;
  sender: {
    firstName: string | null;
    lastName: string | null;
    userName: string | null;
  };
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
export async function healthCheckRepo(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
