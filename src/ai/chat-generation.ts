import type { ModelMessage } from 'ai';
import { dynamicTool, stepCountIs, streamText } from 'ai';
import type { LangfuseTraceClient } from 'langfuse';
import { z } from 'zod';
import type { BotContext } from '../bot';
import { prisma } from '../db';
import { logger } from '../logger';
import { chatModel } from './ai';
import { isChatHistorySearchIntent } from './history-intent';
import { splitSystemMessages } from './prompt';
import { collectStreamedText } from './stream-text';
import {
  canUseChatHistoryTool,
  createChatHistoryTool,
  createUserInfoTool,
  weatherTool,
  wikipediaTool,
} from './tools';
import { createClearMemoryTool, createMemoryTool } from './domain/memory';

export const chatGeneration = async (
  messages: Array<ModelMessage>,
  trace: LangfuseTraceClient | undefined,
  ctx?: BotContext,
  onTextUpdate?: (text: string) => Promise<void> | void,
  options: {
    readOnlyTools?: boolean;
    allowChatHistory?: boolean;
    allowChatHistoryReadOnly?: boolean;
    model?: typeof chatModel;
  } = {},
) => {
  const greetingTool = dynamicTool({
    description: 'Установить приветствие для нового пользователя в чате',
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
  const userInfoTool = createUserInfoTool(ctx);
  const canReadChatHistory =
    Boolean(options.allowChatHistory) &&
    (canUseChatHistoryTool(ctx, Boolean(options.readOnlyTools)) ||
      Boolean(options.allowChatHistoryReadOnly));
  const requireChatHistorySearch =
    !options.readOnlyTools &&
    canReadChatHistory &&
    isChatHistorySearchIntent(
      ctx?.msg?.text ?? ctx?.msg?.caption,
      ctx?.msg?.reply_to_message?.text ?? ctx?.msg?.reply_to_message?.caption,
    );

  trace?.update({
    input: JSON.stringify(messages),
  });

  const prompt = splitSystemMessages(messages);

  const generationStartedAt = performance.now();
  let firstTextAt: number | null = null;
  const generationOptions = {
    model: options.model ?? chatModel,
    instructions: prompt.instructions,
    messages: prompt.messages,
    stopWhen: stepCountIs(5),
    temperature: 1,
  };
  const readOnlyToolSet = {
    get_weather: weatherTool,
    wikipedia: wikipediaTool,
    get_user_info: userInfoTool,
  };
  const writableToolSet = {
    get_weather: weatherTool,
    set_greeting: greetingTool,
    wikipedia: wikipediaTool,
    save_memory: memoryTool,
    clear_memory: clearMemoryTool,
    get_user_info: userInfoTool,
    ...(canReadChatHistory
      ? { search_chat_history: createChatHistoryTool(ctx) }
      : {}),
  };
  const response = requireChatHistorySearch
    ? streamText({
        ...generationOptions,
        tools: writableToolSet,
        prepareStep: ({ stepNumber }) =>
          stepNumber === 0
            ? {
                toolChoice: {
                  type: 'tool' as const,
                  toolName: 'search_chat_history' as const,
                },
              }
            : { toolChoice: 'none' as const },
      })
    : streamText({
        ...generationOptions,
        tools: options.readOnlyTools ? readOnlyToolSet : writableToolSet,
      });

  async function* measuredTextStream() {
    for await (const delta of response.textStream) {
      if (delta && firstTextAt === null) {
        firstTextAt = performance.now();
      }
      yield delta;
    }
  }

  const text = await collectStreamedText(
    measuredTextStream(),
    response.text,
    onTextUpdate,
  );

  const completedAt = performance.now();
  logger.info(
    {
      event: 'ai.generation_completed',
      ttftMs:
        firstTextAt === null
          ? null
          : Math.round(firstTextAt - generationStartedAt),
      totalMs: Math.round(completedAt - generationStartedAt),
    },
    'Chat generation completed',
  );

  trace?.update({
    output: JSON.stringify(text),
  });

  return text;
};
