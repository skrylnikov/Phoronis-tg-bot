import type { Schemas } from '@qdrant/js-client-rest';
import { embed, generateText, Output } from 'ai';
import { z } from 'zod';
import { openRouter } from '../../ai/ai';
import { prisma } from '../../db';
import { logger } from '../../logger';
import { qdrantClient } from '../../qdrant';

interface SaveMemoryOptions {
  userId: number;
  chatId: number;
  content: string;
  isUser: boolean;
}

interface CheckSimilarResult {
  isDuplicate: boolean;
  isContradiction: boolean;
  similarMemoryId?: bigint;
}

const SEARCH_THRESHOLD = 0.6;

const memoryCheckSchema = z.object({
  duplicateId: z
    .string()
    .nullable()
    .describe('ID дубликата записи, если найден'),
  contradictionId: z
    .string()
    .nullable()
    .describe('ID противоречащей записи, если найдена'),
  reason: z.string().describe('Объяснение решения'),
});

async function checkForSimilarMemories(
  userId: number,
  chatId: number,
  content: string,
  isUser: boolean,
): Promise<CheckSimilarResult> {
  try {
    const result = await embed({
      model: openRouter.textEmbeddingModel('qwen/qwen3-embedding-8b'),
      value: content,
      providerOptions: {
        llamaGate: {
          dimensions: 4096,
        },
      },
    });

    const filter: Schemas['Filter'] = {
      must: [
        {
          key: 'isUser',
          match: {
            value: isUser,
          },
        },
        {
          key: isUser ? 'userId' : 'chatId',
          match: {
            value: isUser ? userId : chatId,
          },
        },
      ],
    };

    const searchResults = await qdrantClient.search('memories', {
      vector: result.embedding,
      filter,
      score_threshold: SEARCH_THRESHOLD,
      limit: 5,
      with_payload: true,
    });

    if (searchResults.length === 0) {
      return { isDuplicate: false, isContradiction: false };
    }

    const candidates = searchResults
      .map(
        (r, i) =>
          `${i + 1}. [ID: ${String(r.id)}] ${r.payload?.content as string}`,
      )
      .join('\n');

    const llmResult = await generateText({
      model: openRouter('openai/gpt-oss-120b'),
      output: Output.object({ schema: memoryCheckSchema }),
      prompt: `Анализируй новую запись и существующие записи на предмет дубликатов и противоречий.

Новая запись для сохранения:
"${content}"

Существующие похожие записи:
${candidates}

Определи:
1. Есть ли точный дубликат (то же самое утверждение с тем же смыслом)
2. Есть ли противоречие (противоположное утверждение об том же объекте/факте)

Если дубликат найден - верни его ID.
Если противоречие найдено - верни его ID.
Если нет ни того ни другого - верни null для обоих полей.`,
      temperature: 0,
    });

    if (llmResult.output.duplicateId) {
      return {
        isDuplicate: true,
        isContradiction: false,
        similarMemoryId: BigInt(llmResult.output.duplicateId),
      };
    }

    if (llmResult.output.contradictionId) {
      return {
        isDuplicate: false,
        isContradiction: true,
        similarMemoryId: BigInt(llmResult.output.contradictionId),
      };
    }

    return { isDuplicate: false, isContradiction: false };
  } catch (error) {
    console.error('Error checking for similar memories:', error);
    return { isDuplicate: false, isContradiction: false };
  }
}

async function upsertMemoryEmbedding(
  memoryId: bigint,
  embedding: number[],
  content: string,
  userId: number,
  chatId: number,
  isUser: boolean,
) {
  await qdrantClient.upsert('memories', {
    points: [
      {
        id: Number(memoryId),
        vector: embedding,
        payload: {
          content,
          userId,
          chatId,
          isUser,
        },
      },
    ],
  });
}

export async function saveMemory(options: SaveMemoryOptions) {
  const { userId, chatId, content, isUser } = options;

  const checkResult = await checkForSimilarMemories(
    userId,
    chatId,
    content,
    isUser,
  );

  if (checkResult.isDuplicate && checkResult.similarMemoryId) {
    await prisma.memory.update({
      where: { id: checkResult.similarMemoryId },
      data: {
        content,
        updatedAt: new Date(),
      },
    });

    try {
      const result = await embed({
        model: openRouter.textEmbeddingModel('qwen/qwen3-embedding-8b'),
        value: content,
        providerOptions: {
          llamaGate: {
            dimensions: 4096,
          },
        },
      });

      await upsertMemoryEmbedding(
        checkResult.similarMemoryId,
        result.embedding,
        content,
        userId,
        chatId,
        isUser,
      );
    } catch (error) {
      console.error('Error updating duplicate memory embedding:', error);
    }

    return checkResult.similarMemoryId;
  }

  if (checkResult.isContradiction && checkResult.similarMemoryId) {
    await prisma.memory.update({
      where: { id: checkResult.similarMemoryId },
      data: {
        content,
        updatedAt: new Date(),
      },
    });

    try {
      const result = await embed({
        model: openRouter.textEmbeddingModel('qwen/qwen3-embedding-8b'),
        value: content,
        providerOptions: {
          llamaGate: {
            dimensions: 4096,
          },
        },
      });

      await upsertMemoryEmbedding(
        checkResult.similarMemoryId,
        result.embedding,
        content,
        userId,
        chatId,
        isUser,
      );
    } catch (error) {
      console.error('Error updating contradiction memory embedding:', error);
    }

    return checkResult.similarMemoryId;
  }

  const memory = await prisma.memory.create({
    data: {
      userId: BigInt(userId),
      chatId: BigInt(chatId),
      content,
      isUser,
    },
  });

  try {
    const result = await embed({
      model: openRouter.textEmbeddingModel('qwen/qwen3-embedding-8b'),
      value: content,
      providerOptions: {
        llamaGate: {
          dimensions: 4096,
        },
      },
    });

    await upsertMemoryEmbedding(
      memory.id,
      result.embedding,
      content,
      userId,
      chatId,
      isUser,
    );
  } catch (error) {
    console.error('Error embedding memory:', error);
  }

  return memory.id;
}

export type ClearMemoryScope = 'personal' | 'shared' | 'all';

export interface ClearMemoryOptions {
  userId: number;
  chatId: number;
  scope: ClearMemoryScope;
}

export async function clearMemories(options: ClearMemoryOptions): Promise<number> {
  const { userId, chatId, scope } = options;

  const where =
    scope === 'personal'
      ? {
          userId: BigInt(userId),
          chatId: BigInt(chatId),
          isUser: true,
        }
      : scope === 'shared'
        ? {
            chatId: BigInt(chatId),
            isUser: false,
          }
        : {
            OR: [
              {
                userId: BigInt(userId),
                chatId: BigInt(chatId),
                isUser: true,
              },
              {
                chatId: BigInt(chatId),
                isUser: false,
              },
            ],
          };

  const rows = await prisma.memory.findMany({
    where,
    select: { id: true },
  });

  if (rows.length === 0) {
    return 0;
  }

  const ids = rows.map((r) => r.id);

  await prisma.memory.deleteMany({
    where: { id: { in: ids } },
  });

  try {
    await qdrantClient.delete('memories', {
      points: ids.map((id) => Number(id)),
    });
  } catch (error) {
    logger.error(error, 'clearMemories: Qdrant delete failed');
  }

  return rows.length;
}

export async function getRecentMemories(
  userId: number,
  chatId: number,
  limit: number = 10,
): Promise<string[]> {
  const memories = await prisma.memory.findMany({
    where: {
      OR: [
        {
          userId: BigInt(userId),
          isUser: true,
        },
        {
          chatId: BigInt(chatId),
          isUser: false,
        },
      ],
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: limit,
  });

  return memories.map((m: { content: string }) => m.content);
}

export async function getRecentMemoriesForUsers(
  userIds: number[],
  chatId: number,
  limit: number = 10,
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();

  userIds.forEach((id) => {
    result.set(id, []);
  });

  const userMemories = await prisma.memory.findMany({
    where: {
      userId: { in: userIds.map(BigInt) },
      isUser: true,
    },
    orderBy: { createdAt: 'desc' },
    take: userIds.length * limit,
  });

  userMemories.forEach((memory) => {
    const userId = Number(memory.userId);
    const userMemories = result.get(userId);
    if (userMemories && userMemories.length < limit) {
      userMemories.push(memory.content);
    }
  });

  const chatMemories = await prisma.memory.findMany({
    where: {
      chatId: BigInt(chatId),
      isUser: false,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const chatMemoriesContent = chatMemories.map((m) => m.content);

  userIds.forEach((id) => {
    const userMemories = result.get(id) || [];
    result.set(id, [...userMemories, ...chatMemoriesContent]);
  });

  return result;
}
