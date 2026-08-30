import type { LangfuseSpan } from '@langfuse/tracing';
import type { ModelMessage } from 'ai';
import { dynamicTool, stepCountIs, streamText } from 'ai';
import { z } from 'zod';
import type { BotContext } from '../bot';
import { logger } from '../logger';
import { updateChatRepo } from '../repositories/chat-repository';
import { currentUpdateAbortSignal } from '../update-signal';
import { chatModel } from './ai';
import { isChatHistorySearchIntent } from './history-intent';
import { splitSystemMessages } from './prompt';
import { collectStreamedText } from './stream-text';
import {
  canUseChatHistoryTool,
  createChatHistoryTool,
  createUserInfoTool,
  createWebTools,
  weatherTool,
  wikipediaTool,
} from './tools';
import { createClearMemoryTool, createMemoryTool } from './tools/memory';

export const chatGeneration = async (
  messages: Array<ModelMessage>,
  observation: LangfuseSpan | undefined,
  ctx?: BotContext,
  onTextUpdate?: (text: string) => Promise<void> | void,
  options: {
    readOnlyTools?: boolean;
    allowChatHistory?: boolean;
    allowChatHistoryReadOnly?: boolean;
    maxOutputTokens?: number;
    model?: typeof chatModel;
  } = {},
) => {
  const greetingTool = dynamicTool({
    description: 'Установить приветствие для нового пользователя в чате',
    inputSchema: z.object({
      greeting: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .describe('Текст приветствия'),
    }),
    execute: async (input: unknown) => {
      const greeting = (input as { greeting?: unknown }).greeting;
      try {
        if (!ctx?.from || ctx.chatId === undefined) {
          return JSON.stringify({ error: 'Контекст не передан' });
        }
        const currentUserId = ctx.from.id;
        const currentChatId = ctx.chatId;
        if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') {
          return JSON.stringify({
            error: 'Приветствие можно установить только в группе',
          });
        }
        const normalizedGreeting =
          typeof greeting === 'string' ? greeting.trim() : '';
        if (normalizedGreeting.length < 1 || normalizedGreeting.length > 4096) {
          return JSON.stringify({
            error: 'Приветствие должно содержать от 1 до 4096 символов',
          });
        }

        const adminList = await ctx.api.getChatAdministrators(currentChatId);
        if (
          !adminList.some(
            (admin) =>
              (admin.status === 'administrator' ||
                admin.status === 'creator') &&
              admin.user.id === currentUserId,
          )
        ) {
          return JSON.stringify({
            error: 'Не хватает прав для установки приветствия',
          });
        }

        await updateChatRepo(BigInt(currentChatId), {
          greeting: normalizedGreeting,
        });

        return JSON.stringify({
          message: `Приветствие установлено: ${normalizedGreeting}`,
        });
      } catch (_error) {
        return JSON.stringify({ error: 'Ошибка при установке приветствия' });
      }
    },
  });

  const memoryTool = createMemoryTool(ctx);
  const clearMemoryTool = createClearMemoryTool(ctx);
  const userInfoTool = createUserInfoTool(ctx);
  const webTools = createWebTools();
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

  const prompt = splitSystemMessages(messages);

  const generationStartedAt = performance.now();
  let firstTextAt: number | null = null;
  const generationOptions = {
    abortSignal: currentUpdateAbortSignal(),
    model: options.model ?? chatModel,
    instructions: prompt.instructions,
    messages: prompt.messages,
    maxOutputTokens: options.maxOutputTokens,
    stopWhen: stepCountIs(5),
    temperature: 1,
  };
  const readOnlyToolSet = {
    get_weather: weatherTool,
    wikipedia: wikipediaTool,
    get_user_info: userInfoTool,
    ...(webTools ?? {}),
  };
  const writableToolSet = {
    get_weather: weatherTool,
    set_greeting: greetingTool,
    wikipedia: wikipediaTool,
    save_memory: memoryTool,
    clear_memory: clearMemoryTool,
    get_user_info: userInfoTool,
    ...(webTools ?? {}),
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

  observation?.update({
    metadata: {
      inputMessageCount: messages.length,
      inputCharacters: JSON.stringify(messages).length,
      outputCharacters: text.length,
      latencyMs: Math.round(completedAt - generationStartedAt),
      providerCacheRead: 'unavailable',
      providerCacheWrite: 'unavailable',
    },
  });

  return text;
};
