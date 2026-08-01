import pgvector from 'pgvector';
import { embeddingVersion } from '../../config';
import { prisma } from '../../db';
import { Prisma } from '../../generated/prisma/client';

export interface SimilarMemory {
  id: bigint;
  content: string;
  similarity: number;
}

export interface SimilarFact {
  id: bigint;
  content: string;
  similarity: number;
}

function toVectorSql(embedding: number[]): string {
  const value = pgvector.toSql(embedding);
  if (!value) {
    throw new Error('Cannot serialize an empty embedding');
  }
  return value;
}

export async function updateMessageEmbedding(
  chatId: bigint,
  messageId: bigint,
  searchText: string,
  embedding: number[],
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

export async function markMessageEmbeddingSkipped(
  chatId: bigint,
  messageId: bigint,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Message"
    SET "searchText" = NULL,
        "embedding" = NULL,
        "embeddingVersion" = ${embeddingVersion}
    WHERE "chatId" = ${chatId} AND "id" = ${messageId}
  `;
}

export async function updateMemoryEmbedding(
  memoryId: bigint,
  embedding: number[],
): Promise<void> {
  const vector = toVectorSql(embedding);
  await prisma.$executeRaw`
    UPDATE "Memory"
    SET "embedding" = ${vector}::vector,
        "embeddingVersion" = ${embeddingVersion}
    WHERE "id" = ${memoryId}
  `;
}

export async function updateFactEmbedding(
  factId: bigint,
  embedding: number[],
): Promise<void> {
  const vector = toVectorSql(embedding);
  await prisma.$executeRaw`
    UPDATE "UserFact"
    SET "embedding" = ${vector}::vector,
        "embeddingVersion" = ${embeddingVersion}
    WHERE "id" = ${factId}
  `;
}

export async function searchUserMessageContext(
  userId: bigint,
  embedding: number[],
  threshold: number,
  limit: number,
): Promise<string[]> {
  const vector = toVectorSql(embedding);
  const rows = await prisma.$queryRaw<Array<{ content: string }>>`
    SELECT "searchText" AS content
    FROM "Message"
    WHERE "senderId" = ${userId}
      AND "private" IS NOT TRUE
      AND "embeddingVersion" = ${embeddingVersion}
      AND "embedding" IS NOT NULL
      AND "searchText" IS NOT NULL
      AND 1 - ("embedding" <=> ${vector}::vector) >= ${threshold}
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;
  return rows.map((row) => row.content);
}

export async function searchChatMessageContext(
  chatId: bigint,
  embedding: number[],
  threshold: number,
  limit: number,
): Promise<string[]> {
  const vector = toVectorSql(embedding);
  const rows = await prisma.$queryRaw<Array<{ content: string }>>`
    SELECT "searchText" AS content
    FROM "Message"
    WHERE "chatId" = ${chatId}
      AND "private" IS NOT TRUE
      AND "embeddingVersion" = ${embeddingVersion}
      AND "embedding" IS NOT NULL
      AND "searchText" IS NOT NULL
      AND 1 - ("embedding" <=> ${vector}::vector) >= ${threshold}
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;
  return rows.map((row) => row.content);
}

export interface SimilarChatMessage {
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

export interface LexicalChatMessage
  extends Omit<SimilarChatMessage, 'similarity'> {
  lexicalRank: number;
  exactMatch: boolean;
}

const messageSearchDocument = Prisma.sql`
  coalesce(m."text", '') || ' ' ||
  coalesce(m."summary", '') || ' ' ||
  coalesce(m."searchText", '')
`;

const messageSearchVector = Prisma.sql`
  to_tsvector('russian'::regconfig, ${messageSearchDocument}) ||
  to_tsvector('english'::regconfig, ${messageSearchDocument})
`;

function messageSearchQuery(query: string) {
  return Prisma.sql`
    websearch_to_tsquery('russian'::regconfig, ${query}) ||
    websearch_to_tsquery('english'::regconfig, ${query})
  `;
}

function buildBroadSearchQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '')}"`)
    .join(' OR ');
}

export async function searchChatMessages(params: {
  chatId: bigint;
  embedding: number[];
  threshold: number;
  limit: number;
  beforeMessageId?: bigint;
  senderId?: bigint;
  startAt?: Date;
  endAt?: Date;
}): Promise<SimilarChatMessage[]> {
  const vector = toVectorSql(params.embedding);
  const conditions = [
    Prisma.sql`m."chatId" = ${params.chatId}`,
    Prisma.sql`m."private" = FALSE`,
    Prisma.sql`m."embeddingVersion" = ${embeddingVersion}`,
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

  return prisma.$queryRaw<SimilarChatMessage[]>(Prisma.sql`
    SELECT
      m."id",
      m."replyToMessageId",
      m."senderId",
      m."messageType",
      m."sentAt",
      m."text",
      m."summary",
      m."searchText",
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

export async function searchChatMessagesLexical(params: {
  chatId: bigint;
  query: string;
  limit: number;
  beforeMessageId?: bigint;
  senderId?: bigint;
  startAt?: Date;
  endAt?: Date;
}): Promise<LexicalChatMessage[]> {
  const broadQuery = buildBroadSearchQuery(params.query);
  const conditions = [
    Prisma.sql`m."chatId" = ${params.chatId}`,
    Prisma.sql`m."private" = FALSE`,
    Prisma.sql`(
      m."text" IS NOT NULL OR
      m."summary" IS NOT NULL OR
      m."searchText" IS NOT NULL
    )`,
    Prisma.sql`
      (
        (${messageSearchVector}) @@
          (${messageSearchQuery(params.query)})
        OR
        (${messageSearchVector}) @@
          (${messageSearchQuery(broadQuery)})
      )
    `,
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

  return prisma.$queryRaw<LexicalChatMessage[]>(Prisma.sql`
    SELECT
      m."id",
      m."replyToMessageId",
      m."senderId",
      m."messageType",
      m."sentAt",
      m."text",
      m."summary",
      m."searchText",
      GREATEST(
        ts_rank_cd(
          (${messageSearchVector}),
          (${messageSearchQuery(params.query)})
        ),
        ts_rank_cd(
          (${messageSearchVector}),
          (${messageSearchQuery(broadQuery)})
        ) * 0.75
      )::float8 AS "lexicalRank",
      strpos(
        lower(${messageSearchDocument}),
        lower(${params.query})
      ) > 0 AS "exactMatch",
      json_build_object(
        'firstName', u."firstName",
        'lastName', u."lastName",
        'userName', u."userName"
      ) AS "sender"
    FROM "Message" m
    JOIN "User" u ON u."id" = m."senderId"
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY
      "exactMatch" DESC,
      "lexicalRank" DESC,
      m."id" DESC
    LIMIT ${params.limit}
  `);
}

export async function searchSimilarMemories(
  userId: bigint,
  chatId: bigint,
  isUser: boolean,
  embedding: number[],
  threshold: number,
  limit: number,
): Promise<SimilarMemory[]> {
  const vector = toVectorSql(embedding);
  if (isUser) {
    return prisma.$queryRaw<SimilarMemory[]>`
      SELECT "id", "content", 1 - ("embedding" <=> ${vector}::vector) AS similarity
      FROM "Memory"
      WHERE "isUser" = TRUE
        AND "userId" = ${userId}
        AND "embeddingVersion" = ${embeddingVersion}
        AND "embedding" IS NOT NULL
        AND 1 - ("embedding" <=> ${vector}::vector) >= ${threshold}
      ORDER BY "embedding" <=> ${vector}::vector
      LIMIT ${limit}
    `;
  }

  return prisma.$queryRaw<SimilarMemory[]>`
    SELECT "id", "content", 1 - ("embedding" <=> ${vector}::vector) AS similarity
    FROM "Memory"
    WHERE "isUser" = FALSE
      AND "chatId" = ${chatId}
      AND "embeddingVersion" = ${embeddingVersion}
      AND "embedding" IS NOT NULL
      AND 1 - ("embedding" <=> ${vector}::vector) >= ${threshold}
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;
}

export async function searchSimilarFacts(
  userId: bigint,
  embedding: number[],
  threshold: number,
  limit: number,
  type?: string,
): Promise<SimilarFact[]> {
  const vector = toVectorSql(embedding);
  if (type) {
    return prisma.$queryRaw<SimilarFact[]>`
      SELECT "id", "content", 1 - ("embedding" <=> ${vector}::vector) AS similarity
      FROM "UserFact"
      WHERE "userId" = ${userId}
        AND "type"::text = ${type}
        AND "embeddingVersion" = ${embeddingVersion}
        AND "embedding" IS NOT NULL
        AND 1 - ("embedding" <=> ${vector}::vector) >= ${threshold}
      ORDER BY "embedding" <=> ${vector}::vector
      LIMIT ${limit}
    `;
  }

  return prisma.$queryRaw<SimilarFact[]>`
    SELECT "id", "content", 1 - ("embedding" <=> ${vector}::vector) AS similarity
    FROM "UserFact"
    WHERE "userId" = ${userId}
      AND "embeddingVersion" = ${embeddingVersion}
      AND "embedding" IS NOT NULL
      AND 1 - ("embedding" <=> ${vector}::vector) >= ${threshold}
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;
}
