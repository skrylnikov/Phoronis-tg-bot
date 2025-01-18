import { Message } from "@prisma/client";
import { logger } from '../../logger';

import { openai } from "../../openai";
import { prisma } from "../../db";

export async function analyzeUserMetaInfo(userId: bigint, messages: Message[]) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    const existingMeta = (user?.metaInfo as Record<string, any>) || {};

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Ты - аналитик, который анализирует сообщения пользователя и объединяет существующую и новую метаинформацию.
          Твоя задача - создать обновленное описание пользователя, объединив существующие данные с новыми наблюдениями.
          Верни ответ в формате JSON с полями:
          - interests: массив интересов (объедини существующие и новые, удали дубликаты, сохрани все релевантные, не более 10)
          - communication_style: массив стилей общения (обнови на основе новых сообщений, если есть изменения, не более 3)
          - notable_traits: заметные черты (объедини существующие и новые наблюдения, не более 15)
          - topics: основные темы обсуждений (добавь новые темы к существующим, не более 20)
          
          Анализируй внимательно и сохраняй всю важную историческую информацию, дополняя её новыми наблюдениями.`,
        },
        {
          role: "user",
          content: `Существующая метаинформация о пользователе:
${JSON.stringify(existingMeta, null, 2)}

Проанализируй новые сообщения пользователя и создай обновленную метаинформацию:
${messages.map((m) => m.text).join("\n")}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const metaInfo = completion.choices[0].message.content!;
    const updatedMeta = JSON.parse(metaInfo);

    logger.debug(`Update metadata for user ${JSON.stringify(user)}`, JSON.stringify(updatedMeta));

    await prisma.user.update({
      where: { id: userId },
      data: {
        metaInfo: updatedMeta,
      },
    });

    return updatedMeta;
  } catch (error) {
    logger.error("Error analyzing user meta info:", error);
    return null;
  }
}

export async function updateUserMetaInfo(
  userId: bigint,
  newInfo: Record<string, any>
) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    const currentMeta = (user?.metaInfo as Record<string, any>) || {};
    const updatedMeta = { ...currentMeta, ...newInfo };

    await prisma.user.update({
      where: { id: userId },
      data: {
        metaInfo: updatedMeta,
      },
    });

    return updatedMeta;
  } catch (error) {
    logger.error("Error updating user meta info:", error);
    return null;
  }
}
