import type { ModelMessage } from 'ai';
import { dynamicTool, stepCountIs, streamText } from 'ai';
import type { LangfuseTraceClient } from 'langfuse';
import { z } from 'zod';
import type { BotContext } from '../bot';
import { prisma } from '../db';
import { chatModel } from './ai';
import { splitSystemMessages } from './prompt';
import { collectStreamedText } from './stream-text';
import { weatherTool, wikipediaTool } from './tools';
import { createClearMemoryTool, createMemoryTool } from './tools/memory';

export const chatGeneration = async (
  messages: Array<ModelMessage>,
  trace: LangfuseTraceClient | undefined,
  ctx?: BotContext,
  onTextUpdate?: (text: string) => Promise<void> | void,
  options: { readOnlyTools?: boolean } = {},
) => {
  const greetingTool = dynamicTool({
    description:
      'Установить приветствие для нового пользователя в чате. Требует прав администратора.',
    inputSchema: z.object({
      chatId: z.number().describe('ID чата'),
      userId: z
        .number()
        .describe('ID пользователя, который устанавливает приветствие'),
      greeting: z.string().describe('Текст приветствия'),
    }),
    execute: async (input: unknown) => {
      const { chatId, userId, greeting } = input as {
        chatId: number;
        userId: number;
        greeting: string;
      };
      try {
        if (!ctx) {
          return JSON.stringify({ error: 'Контекст не передан' });
        }

        const adminList = await ctx.api.getChatAdministrators(chatId);
        if (
          !adminList.some(
            (admin) =>
              (admin.status === 'administrator' ||
                admin.status === 'creator') &&
              admin.user.id === userId,
          )
        ) {
          return JSON.stringify({
            error: 'Не хватает прав для установки приветствия',
          });
        }

        await prisma.chat.update({
          where: { id: BigInt(chatId) },
          data: { greeting },
        });

        return JSON.stringify({
          message: `Приветствие установлено: ${greeting}`,
        });
      } catch (_error) {
        return JSON.stringify({ error: 'Ошибка при установке приветствия' });
      }
    },
  });

  const memoryTool = createMemoryTool(ctx);
  const clearMemoryTool = createClearMemoryTool(ctx);

  trace?.update({
    input: JSON.stringify(messages),
  });

  const prompt = splitSystemMessages(messages);

  const response = streamText({
    model: chatModel,
    instructions: prompt.instructions,
    messages: prompt.messages,
    tools: options.readOnlyTools
      ? {
          get_weather: weatherTool,
          wikipedia: wikipediaTool,
        }
      : {
          get_weather: weatherTool,
          set_greeting: greetingTool,
          wikipedia: wikipediaTool,
          save_memory: memoryTool,
          clear_memory: clearMemoryTool,
        },
    stopWhen: stepCountIs(5),
    temperature: 1,
  });

  const text = await collectStreamedText(
    response.textStream,
    response.text,
    onTextUpdate,
  );

  trace?.update({
    output: JSON.stringify(text),
  });

  return text;
};
