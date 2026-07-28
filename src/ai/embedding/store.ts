import pgvector from 'pgvector';
import { embeddingVersion } from '../../config';
import { prisma } from '../../db';

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
