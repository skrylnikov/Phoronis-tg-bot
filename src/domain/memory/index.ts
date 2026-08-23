import { generateText, Output } from 'ai';
import { z } from 'zod';
import { utilityModel } from '../../ai/ai';
import { embedQueryAndPassage } from '../../ai/embedding/client';
import {
  searchSimilarMemories,
  updateMemoryEmbedding,
} from '../../ai/embedding/store';
import { logger } from '../../logger';
import {
  createMemoryRepo,
  deleteMemoriesRepo,
  findMemoriesForClearRepo,
  findRecentMemoriesForUsersRepo,
  findRecentMemoriesRepo,
  getUserPersonalMemoriesRepo,
  updateMemoryRepo,
} from '../../repositories/memory-repository';
import { currentUpdateAbortSignalWithTimeout } from '../../update-signal';

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
  embedding?: number[];
}

const SEARCH_THRESHOLD = 0.82;
const similarityCheckTimeoutMs = 10_000;

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
    const { queryEmbedding, passageEmbedding } =
      await embedQueryAndPassage(content);
    const searchResults = await searchSimilarMemories(
      BigInt(userId),
      BigInt(chatId),
      isUser,
      queryEmbedding,
      SEARCH_THRESHOLD,
      5,
    );

    if (searchResults.length === 0) {
      return {
        isDuplicate: false,
        isContradiction: false,
        embedding: passageEmbedding,
      };
    }

    const candidates = searchResults
      .map(
        (result, index) =>
          `${index + 1}. [ID: ${String(result.id)}] ${result.content}`,
      )
      .join('\n');

    const llmResult = await generateText({
      abortSignal: currentUpdateAbortSignalWithTimeout(
        similarityCheckTimeoutMs,
      ),
      model: utilityModel,
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
        embedding: passageEmbedding,
      };
    }

    if (llmResult.output.contradictionId) {
      return {
        isDuplicate: false,
        isContradiction: true,
        similarMemoryId: BigInt(llmResult.output.contradictionId),
        embedding: passageEmbedding,
      };
    }

    return {
      isDuplicate: false,
      isContradiction: false,
      embedding: passageEmbedding,
    };
  } catch (err) {
    const noOutput =
      err instanceof Error && err.name === 'AI_NoOutputGeneratedError';
    logger[noOutput ? 'warn' : 'error'](
      {
        event: noOutput
          ? 'memory.similarity_check_unavailable'
          : 'memory.similarity_check_failed',
        err,
      },
      noOutput
        ? 'Memory similarity check returned no structured output'
        : 'Memory similarity check failed',
    );
    return { isDuplicate: false, isContradiction: false };
  }
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
    await updateMemoryRepo(checkResult.similarMemoryId, {
      content,
      updatedAt: new Date(),
    });

    if (checkResult.embedding) {
      await updateMemoryEmbedding(
        checkResult.similarMemoryId,
        checkResult.embedding,
      );
    }

    return checkResult.similarMemoryId;
  }

  if (checkResult.isContradiction && checkResult.similarMemoryId) {
    await updateMemoryRepo(checkResult.similarMemoryId, {
      content,
      updatedAt: new Date(),
    });

    if (checkResult.embedding) {
      await updateMemoryEmbedding(
        checkResult.similarMemoryId,
        checkResult.embedding,
      );
    }

    return checkResult.similarMemoryId;
  }

  const memory = await createMemoryRepo({
    userId: BigInt(userId),
    chatId: BigInt(chatId),
    content,
    isUser,
  });

  if (checkResult.embedding) {
    await updateMemoryEmbedding(memory.id, checkResult.embedding);
  }

  return memory.id;
}

export type ClearMemoryScope = 'personal' | 'shared' | 'all';

export interface ClearMemoryOptions {
  userId: number;
  chatId: number;
  scope: ClearMemoryScope;
}

export async function clearMemories(
  options: ClearMemoryOptions,
): Promise<number> {
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

  const rows = await findMemoriesForClearRepo(where);

  if (rows.length === 0) {
    return 0;
  }

  const ids = rows.map((r) => r.id);

  await deleteMemoriesRepo(ids);

  return rows.length;
}

export async function getRecentMemories(
  userId: number,
  chatId: number,
  limit: number = 10,
): Promise<string[]> {
  const memories = await findRecentMemoriesRepo(
    BigInt(userId),
    BigInt(chatId),
    limit,
  );

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

  const { userMemories, chatMemories } = await findRecentMemoriesForUsersRepo(
    userIds,
    BigInt(chatId),
    limit,
  );

  userMemories.forEach((memory) => {
    const userId = Number(memory.userId);
    const userMemoriesArray = result.get(userId);
    if (userMemoriesArray && userMemoriesArray.length < limit) {
      userMemoriesArray.push(memory.content);
    }
  });

  const chatMemoriesContent = chatMemories.map((m) => m.content);

  userIds.forEach((id) => {
    const userMemoriesArray = result.get(id) || [];
    result.set(id, [...userMemoriesArray, ...chatMemoriesContent]);
  });

  return result;
}

export async function getUserPersonalMemories(
  userId: bigint,
  options: { chatId?: bigint; allChats?: boolean } = {},
) {
  return getUserPersonalMemoriesRepo(userId, options);
}
