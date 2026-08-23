import { embeddingVersion } from '../../config';
import {
  markMessageEmbeddingSkippedRepo,
  searchChatMessageContextRepo,
  searchChatMessagesLexicalRepo,
  searchChatMessagesRepo,
  searchSimilarFactsVersionedRepo,
  searchSimilarMemoriesVersionedRepo,
  searchUserMessageContextRepo,
  updateMemoryEmbeddingRepo,
  updateMessageEmbeddingRepo,
  updateUserFactEmbeddingRepo,
} from '../../repositories/embedding-repository';

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

export function updateMessageEmbedding(
  chatId: bigint,
  messageId: bigint,
  searchText: string,
  embedding: number[],
): Promise<void> {
  return updateMessageEmbeddingRepo(
    chatId,
    messageId,
    searchText,
    embedding,
    embeddingVersion,
  );
}

export function markMessageEmbeddingSkipped(
  chatId: bigint,
  messageId: bigint,
): Promise<void> {
  return markMessageEmbeddingSkippedRepo(chatId, messageId, embeddingVersion);
}

export function updateMemoryEmbedding(
  memoryId: bigint,
  embedding: number[],
): Promise<void> {
  return updateMemoryEmbeddingRepo(memoryId, embedding, embeddingVersion);
}

export function updateFactEmbedding(
  factId: bigint,
  embedding: number[],
): Promise<void> {
  return updateUserFactEmbeddingRepo(factId, embedding, embeddingVersion);
}

export function searchUserMessageContext(
  userId: bigint,
  embedding: number[],
  threshold: number,
  limit: number,
): Promise<string[]> {
  return searchUserMessageContextRepo(
    userId,
    embedding,
    threshold,
    limit,
    embeddingVersion,
  );
}

export function searchChatMessageContext(
  chatId: bigint,
  embedding: number[],
  threshold: number,
  limit: number,
): Promise<string[]> {
  return searchChatMessageContextRepo(
    chatId,
    embedding,
    threshold,
    limit,
    embeddingVersion,
  );
}

export function searchSimilarMemories(
  userId: bigint,
  chatId: bigint,
  isUser: boolean,
  embedding: number[],
  threshold: number,
  limit: number,
): Promise<SimilarMemory[]> {
  return searchSimilarMemoriesVersionedRepo(
    userId,
    chatId,
    isUser,
    embedding,
    threshold,
    limit,
    embeddingVersion,
  );
}

export function searchSimilarFacts(
  userId: bigint,
  embedding: number[],
  threshold: number,
  limit: number,
  type?: string,
): Promise<SimilarFact[]> {
  return searchSimilarFactsVersionedRepo(
    userId,
    embedding,
    threshold,
    limit,
    embeddingVersion,
    type,
  );
}

export function searchChatMessages(params: {
  chatId: bigint;
  embedding: number[];
  threshold: number;
  limit: number;
  beforeMessageId?: bigint;
  senderId?: bigint;
  startAt?: Date;
  endAt?: Date;
}) {
  return searchChatMessagesRepo({ ...params, version: embeddingVersion });
}

export function searchChatMessagesLexical(params: {
  chatId: bigint;
  query: string;
  limit: number;
  beforeMessageId?: bigint;
  senderId?: bigint;
  startAt?: Date;
  endAt?: Date;
}) {
  return searchChatMessagesLexicalRepo(params);
}
