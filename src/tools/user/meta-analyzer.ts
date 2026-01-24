import { Message } from "@prisma/client";
import { logger } from "../../logger";
import { prisma } from "../../db";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { langfuse, langfuseHandler } from "../../ai/langfuse";
import { openRouterToken } from "../../config";

const userMetaInfoSchema = z.object({
  interests: z.array(
    z.object({
      value: z.string(),
      weight: z.number().default(1),
    })
  ),
  communication_style: z.array(
    z.object({
      value: z.string(),
      weight: z.number().default(1),
    })
  ),
  notable_traits: z.array(
    z.object({
      value: z.string(),
      weight: z.number().default(1),
    })
  ),
  topics: z.array(
    z.object({
      value: z.string(),
      weight: z.number().default(1),
    })
  ),
  notes: z.array(
    z.object({
      value: z.string(),
      weight: z.number().default(1),
    })
  ),
});

type UserMetaInfo = z.infer<typeof userMetaInfoSchema>;

// const gemma3 = new ChatOpenAI({
//   model: "gemma-3-12b-it@q3_k_l",
//   configuration: {
//     baseURL: "http://lamas-station:1234/v1",
//   },
// });

const geminiFlash2 = new ChatOpenAI({
  model: "google/gemini-2.5-flash-lite",
  apiKey: openRouterToken,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
  temperature: 0,
});

export async function analyzeUserMetaInfo(userId: bigint, messages: Message[]) {
  try {
    // const user = await prisma.user.findUnique({
    //   where: { id: userId },
    // });

    // const existingMeta = user?.metaInfo
    //   ? userMetaInfoSchema.parse(user.metaInfo)
    //   : {
    //       interests: [],
    //       communication_style: [],
    //       notable_traits: [],
    //       topics: [],
    //       notes: [],
    //     };

    // // Для большей наглядности в анализе преобразуем существующую метаинформацию в формат "ключ: вес"
    // const existingMetaFormatted = {
    //   interests: existingMeta.interests.reduce(
    //     (acc, item) => ({
    //       ...acc,
    //       [item.value]: item.weight,
    //     }),
    //     {}
    //   ),
    //   communication_style: existingMeta.communication_style.reduce(
    //     (acc, item) => ({
    //       ...acc,
    //       [item.value]: item.weight,
    //     }),
    //     {}
    //   ),
    //   notable_traits: existingMeta.notable_traits.reduce(
    //     (acc, item) => ({
    //       ...acc,
    //       [item.value]: item.weight,
    //     }),
    //     {}
    //   ),
    //   topics: existingMeta.topics.reduce(
    //     (acc, item) => ({
    //       ...acc,
    //       [item.value]: item.weight,
    //     }),
    //     {}
    //   ),
    //   notes: existingMeta.notes.reduce(
    //     (acc, item) => ({
    //       ...acc,
    //       [item.value]: item.weight,
    //     }),
    //     {}
    //   ),
    // };

    const prompt = await langfuse.getPrompt("meta-analyzer");

    const systemPrompt = prompt.compile();

    //     const userPrompt = `Существующая метаинформация о пользователе:
    // ${JSON.stringify(existingMetaFormatted, null, 2)}

    // Проанализируй новые сообщения пользователя и создай обновленную метаинформацию:
    // ${messages.map((m) => m.text).join("\n")}`;

    const userPrompt = `Проанализируй новые сообщения пользователя и создай обновленную метаинформацию:
${messages.map((m) => m.summary || m.text).join("\n")}`;

    const rawMetaInfo = await geminiFlash2
      .withStructuredOutput(userMetaInfoSchema, {
        includeRaw: true,
      })
      .invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)], {
        callbacks: [langfuseHandler],
      });

    const updatedMeta = userMetaInfoSchema.parse(
      JSON.parse(rawMetaInfo.raw.content as string)
    );

    return await updateUserMetaInfo(userId, updatedMeta);

    // logger.debug(
    //   `Update metadata for user ${JSON.stringify({
    //     ...user,
    //     id: Number(user?.id),
    //   })}`,
    //   JSON.stringify(updatedMeta)
    // );

    // await prisma.user.update({
    //   where: { id: userId },
    //   data: {
    //     metaInfo: updatedMeta,
    //   },
    // });
  } catch (error) {
    logger.error(error, "Error analyzing user meta info");
    return null;
  }
}

export function getTopUserMetaInfo(
  rawMetaInfo: unknown,
  count: {
    interests?: number;
    communication_style?: number;
    notable_traits?: number;
    topics?: number;
    notes?: number;
  } = {}
): UserMetaInfo | {} {
  const { success, data: metaInfo } = userMetaInfoSchema.safeParse(rawMetaInfo);

  if (!success) {
    logger.error(rawMetaInfo, "Invalid meta info");
    return {};
  }

  const defaultCounts = {
    interests: 5,
    communication_style: 3,
    notable_traits: 5,
    topics: 5,
    notes: 5,
  };

  const topCounts = { ...defaultCounts, ...count };

  return {
    interests: [...metaInfo.interests]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, topCounts.interests),
    communication_style: [...metaInfo.communication_style]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, topCounts.communication_style),
    notable_traits: [...metaInfo.notable_traits]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, topCounts.notable_traits),
    topics: [...metaInfo.topics]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, topCounts.topics),
    notes: [...metaInfo.notes]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, topCounts.notes),
  };
}

export function mergeMetaInfo(
  existing: UserMetaInfo,
  newItems: Partial<UserMetaInfo>
): UserMetaInfo {
  const result: UserMetaInfo = {
    interests: [...existing.interests],
    communication_style: [...existing.communication_style],
    notable_traits: [...existing.notable_traits],
    topics: [...existing.topics],
    notes: [...existing.notes],
  };

  // Функция для объединения массивов с учетом весов
  const mergeArrays = <T extends { value: string; weight: number }>(
    existingArray: T[],
    newArray: T[] = []
  ): T[] => {
    const merged: Record<string, T> = {};

    // Добавляем существующие элементы
    existingArray.forEach((item) => {
      merged[item.value] = { ...item };
    });

    // Объединяем с новыми, увеличивая вес если элемент уже существует
    newArray.forEach((item) => {
      if (merged[item.value]) {
        merged[item.value].weight += item.weight;
      } else {
        merged[item.value] = { ...item };
      }
    });

    return Object.values(merged);
  };

  // Объединяем каждую категорию
  if (newItems.interests) {
    result.interests = mergeArrays(existing.interests, newItems.interests);
  }

  if (newItems.communication_style) {
    result.communication_style = mergeArrays(
      existing.communication_style,
      newItems.communication_style
    );
  }

  if (newItems.notable_traits) {
    result.notable_traits = mergeArrays(
      existing.notable_traits,
      newItems.notable_traits
    );
  }

  if (newItems.topics) {
    result.topics = mergeArrays(existing.topics, newItems.topics);
  }

  if (newItems.notes) {
    result.notes = mergeArrays(existing.notes, newItems.notes);
  }

  return result;
}

export async function updateUserMetaInfo(
  userId: bigint,
  newInfo: Partial<UserMetaInfo>
) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    const currentMeta = userMetaInfoSchema.safeParse(user?.metaInfo || {});

    const updatedMeta = currentMeta.success
      ? mergeMetaInfo(currentMeta.data, newInfo)
      : newInfo;

    await prisma.user.update({
      where: { id: userId },
      data: {
        metaInfo: updatedMeta,
      },
    });

    return updatedMeta;
  } catch (error) {
    logger.error(error, "Error updating user meta info");
    console.log(error);
    return null;
  }
}

// Пример использования:
/*
// Получение только самых важных элементов метаинформации
const user = await prisma.user.findUnique({ where: { id: userId } });
if (user?.metaInfo) {
  const metaInfo = userMetaInfoSchema.parse(user.metaInfo);
  
  // Получаем топ-3 интереса и топ-2 характеристики коммуникации
  const topInfo = getTopUserMetaInfo(metaInfo, {
    interests: 3,
    communication_style: 2
  });
  
  console.log("Топ 3 интереса:", topInfo.interests.map(i => i.value).join(", "));
  console.log("Топ 2 стиля коммуникации:", topInfo.communication_style.map(c => c.value).join(", "));
}

// Добавление новой информации с увеличением веса
const newInterest = {
  interests: [
    { value: "программирование", weight: 1 },
    { value: "искусственный интеллект", weight: 2 }
  ]
};

// Это увеличит вес существующих интересов или добавит новые
await updateUserMetaInfo(userId, newInterest);
*/
