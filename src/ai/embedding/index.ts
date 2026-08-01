import { logger } from '../../logger';
import { requestEmbeddingBackfill } from './backfill';
import { embedQuery, embedQueryAndPassage } from './client';
import {
  searchChatMessageContext,
  searchUserMessageContext,
  updateMessageEmbedding,
} from './store';

const USER_SCORE_THRESHOLD = 0.82;
const USER_LIMIT = 5;
const CHAT_SCORE_THRESHOLD = 0.85;
const CHAT_LIMIT = 3;

export interface SearchContextResult {
  userContext: string[] | null;
  chatContext: string[] | null;
}

export interface MessageEmbeddingIdentity {
  messageId: number;
  chatId: number;
}

async function searchWithEmbedding(
  embedding: number[],
  userId: number,
  chatId: number,
  isPrivateChat: boolean,
): Promise<SearchContextResult> {
  const startedAt = performance.now();
  const [userContext, chatContext] = await Promise.all([
    searchUserMessageContext(
      BigInt(userId),
      embedding,
      USER_SCORE_THRESHOLD,
      USER_LIMIT,
    ),
    isPrivateChat
      ? Promise.resolve([])
      : searchChatMessageContext(
          BigInt(chatId),
          embedding,
          CHAT_SCORE_THRESHOLD,
          CHAT_LIMIT,
        ),
  ]);

  logger.info(
    {
      durationMs: Math.round(performance.now() - startedAt),
      userResults: userContext.length,
      chatResults: chatContext.length,
    },
    'Vector context search completed',
  );

  return {
    userContext: userContext.length > 0 ? userContext : null,
    chatContext: chatContext.length > 0 ? chatContext : null,
  };
}

export async function searchContext(
  content: string,
  userId: number,
  chatId: number,
  isPrivateChat: boolean,
): Promise<SearchContextResult> {
  if (content.length <= 10) {
    return { userContext: null, chatContext: null };
  }

  try {
    const embedding = await embedQuery(content);
    return await searchWithEmbedding(embedding, userId, chatId, isPrivateChat);
  } catch (error) {
    logger.warn(
      { event: 'embedding.context_search_failed', err: error },
      'Interactive context embedding failed',
    );
    return { userContext: null, chatContext: null };
  }
}

export async function searchAndIndexMessage(
  identity: MessageEmbeddingIdentity,
  content: string,
  userId: number,
  isPrivateChat: boolean,
): Promise<SearchContextResult> {
  if (content.length <= 10) {
    requestEmbeddingBackfill();
    return { userContext: null, chatContext: null };
  }

  try {
    const { queryEmbedding, passageEmbedding } =
      await embedQueryAndPassage(content);
    const context = await searchWithEmbedding(
      queryEmbedding,
      userId,
      identity.chatId,
      isPrivateChat,
    );

    try {
      await updateMessageEmbedding(
        BigInt(identity.chatId),
        BigInt(identity.messageId),
        content,
        passageEmbedding,
      );
    } catch (error) {
      logger.warn(
        { event: 'embedding.message_persist_failed', err: error },
        'Failed to persist interactive message embedding',
      );
      requestEmbeddingBackfill();
    }
    return context;
  } catch (error) {
    logger.warn(
      { event: 'embedding.interactive_failed', err: error },
      'Interactive message embedding failed',
    );
    requestEmbeddingBackfill();
    return { userContext: null, chatContext: null };
  }
}

export function queueMessageEmbedding(): void {
  requestEmbeddingBackfill();
}

export {
  startEmbeddingBackfill,
  stopEmbeddingBackfill,
} from './backfill';
export { checkEmbeddingHealth } from './client';
export { formatMessageSearchText } from './format';
