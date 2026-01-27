import { dynamicTool, generateText, stepCountIs } from 'ai';
import { z } from 'zod';
import type { BotContext } from '../bot';
import { prisma } from '../db';
import { logger } from '../logger';
import { getRecentMemories } from '../tools/memory';
import { openRouter } from './ai';
import { langfuse } from './langfuse';
import { weatherTool, wikipediaTool } from './tools';
import { createMemoryTool } from './tools/memory';

export const chatGeneration = async (
  messages: Array<{ role: string; content: string | Array<unknown> }>,
  trace: any,
  ctx?: BotContext,
) => {
  const prompt = await langfuse.getPrompt('chat-generation');
  const systemPrompt = prompt.compile();

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
      } catch (error) {
        return JSON.stringify({ error: 'Ошибка при установке приветствия' });
      }
    },
  });

  let memoryContext: string[] = [];
  if (ctx?.from && ctx.chatId) {
    try {
      memoryContext = await getRecentMemories(ctx.from.id, ctx.chatId, 10);
    } catch (error) {}
  }

  console.log('Memory context:', memoryContext);

  const memoryTool = createMemoryTool(ctx);

  const fullMessages = [
    {
      role: 'system' as const,
      content: `${systemPrompt}${
        memoryContext.length > 0
          ? '\n\nИнформация из памяти:\n' +
            memoryContext.map((m, i) => `${i + 1}. ${m}`).join('\n')
          : ''
      }`,
    },
    ...messages.map((m) =>
      m.role === 'user'
        ? { role: 'user' as const, content: m.content as string }
        : { role: 'assistant' as const, content: m.content as string },
    ),
  ];

  trace.update({
    input: JSON.stringify(fullMessages),
  });

  const generation = trace.generation({
    prompt,
  });

  const response = await generateText({
    model: openRouter('google/gemini-3-flash-preview'),
    messages: fullMessages,
    tools: {
      get_weather: weatherTool,
      set_greeting: greetingTool,
      wikipedia: wikipediaTool,
      save_memory: memoryTool,
    },
    stopWhen: stepCountIs(5),
    temperature: 1,
  });

  // logger.debug(response);

  generation.update({
    output: JSON.stringify(response.text),
  });

  trace.update({
    output: JSON.stringify(response.text),
  });

  return response.text;
};
