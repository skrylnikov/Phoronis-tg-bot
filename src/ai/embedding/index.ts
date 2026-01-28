import { embed } from 'ai';
import { logger } from '../../logger';
import { qdrantClient } from '../../qdrant';
import { openRouter } from '../ai';

const USER_SCORE_THRESHOLD = 0.6;
const USER_LIMIT = 5;
const CHAT_SCORE_THRESHOLD = 0.7;
const CHAT_LIMIT = 3;

export interface SearchContextResult {
  userContext: string[] | null;
  chatContext: string[] | null;
  embedding?: number[];
}

interface UpsertParams {
  messageId: number;
  embedding: number[];
  content: string;
  text: string | undefined;
  chatId: number;
  userId: number;
}

async function upsertMessageEmbedding({
  messageId,
  embedding,
  content,
  text,
  chatId,
  userId,
}: UpsertParams) {
  await qdrantClient.upsert('messages', {
    points: [
      {
        id: messageId,
        vector: embedding,
        payload: {
          content,
          text,
          chatId,
          userId,
        },
      },
    ],
  });
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
    console.time('Embedding search time');
    const result = await embed({
      model: openRouter.textEmbeddingModel('qwen/qwen3-embedding-8b'),
      value: content,
      providerOptions: {
        llamaGate: {
          dimensions: 4096,
        },
      },
    });
    console.timeEnd('Embedding search time');

    console.time('Qdrant search time');
    const [userSearchResult, chatSearchResult] = await Promise.all([
      qdrantClient.search('messages', {
        vector: result.embedding,
        filter: {
          must: [
            {
              key: 'userId',
              match: {
                value: userId,
              },
            },
          ],
        },
        score_threshold: USER_SCORE_THRESHOLD,
        limit: USER_LIMIT,
        with_payload: true,
        timeout: 3000,
      }),
      !isPrivateChat
        ? qdrantClient.search('messages', {
          vector: result.embedding,
          filter: {
            must: [
              {
                key: 'chatId',
                match: {
                  value: chatId,
                },
              },
            ],
          },
          score_threshold: CHAT_SCORE_THRESHOLD,
          limit: CHAT_LIMIT,
          with_payload: true,
          timeout: 3000,
        })
        : null,
    ]);
    console.timeEnd('Qdrant search time');

    const userContext =
      userSearchResult.length > 0
        ? userSearchResult.map((x) => x.payload!.content as string)
        : null;

    const chatContext =
      chatSearchResult && chatSearchResult.length > 0
        ? chatSearchResult.map((x) => x.payload!.content as string)
        : null;

    return { userContext, chatContext, embedding: result.embedding };

  } catch (error) {
    logger.error(error, 'Embeding search error:');
    return { userContext: null, chatContext: null, embedding: undefined };
  }
}

export function upsertMessage(
  messageId: number,
  embedding: number[],
  content: string,
  text: string | undefined,
  chatId: number,
  userId: number,
) {
  upsertMessageEmbedding({
    messageId,
    embedding,
    content,
    text,
    chatId,
    userId,
  }).catch((error) => logger.error(error));
}
