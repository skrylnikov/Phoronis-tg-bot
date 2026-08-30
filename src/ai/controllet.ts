import type { LangfuseSpan } from '@langfuse/tracing';
import type { ModelMessage } from 'ai';
import { InlineKeyboard } from 'grammy';
import {
  recordAiAttempt,
  recordAiFailure,
  recordAiSuccess,
} from '../analytics-runtime';
import type { BotContext } from '../bot';
import { sessionIdGenerator } from '../config';
import {
  createPurchaseSession,
  releaseQuota,
  reserveQuota,
  saveChat,
  saveMessage,
  saveUser,
  shouldSendLimitNotice,
} from '../domain';
import { extractMentionedUserIds } from '../domain/entities';
import { getRecentMemoriesForUsers } from '../domain/memory';
import { getTopUserFacts } from '../domain/user/fact-analyzer';
import type { Message, User } from '../generated/prisma/client';
import { logger } from '../logger';
import {
  findFirstMessageRepo,
  findManyMessagesRepo,
  findMessageWithSelectRepo,
} from '../repositories/message-repository';
import { findManyUsersRepo } from '../repositories/user-repository';
import { chatModel, liteChatModel } from './ai';
import { chatGeneration } from './chat-generation';
import { searchContext } from './embedding';
import { withAiObservation } from './langfuse';
import { richMarkdownInstructions } from './rich-message';
import { TelegramStreamSink } from './telegram-stream';
import {
  appendAiThreadAssistantEvent,
  buildAiThreadContext,
  buildChatGenerationInstructions,
  chooseChatGenerationRules,
  formatAiContextTime,
  renderChatGenerationRules,
} from './thread-context';
import { getRecentPublicChatContext } from './tools';
import type { TypingStatus } from './typing-status';

function convertFactsToMetaInfo(
  facts: Awaited<ReturnType<typeof getTopUserFacts>>,
) {
  return {
    interests: facts
      .filter((f) => f.type === 'INTEREST')
      .map((f) => ({ value: f.content, weight: f.weight })),
    communication_style: facts
      .filter((f) => f.type === 'TEXT_STYLE')
      .map((f) => ({ value: f.content, weight: f.weight })),
    notable_traits: facts
      .filter((f) => f.type === 'FACT')
      .map((f) => ({ value: f.content, weight: f.weight })),
    topics: [],
    notes: [],
  };
}

const getThread = async (chatId: number, messageId: bigint | null) => {
  const result: Array<Message & { sender: User }> = [];
  while (messageId) {
    const messages = (await findManyMessagesRepo(
      {
        chatId,
        private: false,
        id: {
          gte: messageId,
        },
      },
      {
        include: {
          sender: true,
        },
        take: 10,
      },
    )) as unknown as Array<Message & { sender: User }>;

    if (messages.length === 0) {
      break;
    }
    let lastId: bigint | null = messageId;
    while (lastId) {
      const message = messages.find((x) => x.id === lastId);
      if (!message) {
        break;
      }
      result.push(message);
      lastId = message.replyToMessageId;
    }
    if (messageId === lastId) {
      break;
    }
    messageId = lastId;
  }

  result.reverse();

  return result;
};

const getThreadBySessionId = async (
  chatId: number,
  messageId: bigint | null,
  sessionId: string,
) => {
  const result: Array<Message & { sender: User }> = [];
  const messages = (await findManyMessagesRepo(
    {
      chatId,
      sessionId,
      private: false,
    },
    {
      include: {
        sender: true,
      },
      take: 10,
    },
  )) as unknown as Array<Message & { sender: User }>;

  let lastId: bigint | null = messageId;
  while (lastId) {
    const message = messages.find((x) => x.id === lastId);
    if (!message) {
      break;
    }
    result.push(message);
    lastId = message.replyToMessageId;
  }

  result.reverse();

  return result;
};

interface AiControllerOptions {
  messageText?: string;
  ephemeralReceiverUserId?: number;
  persistResponse?: boolean;
  privateMode?: boolean;
  readOnlyTools?: boolean;
  resolveContext?: boolean;
  includeRecentChatContext?: boolean;
  typingStatus?: TypingStatus;
}

export const aiController = async (
  ctx: BotContext,
  imageDescription?: string,
  userContext?: string[] | null,
  chatContext?: string[] | null,
  options: AiControllerOptions = {},
) => {
  const msg = ctx.msg;
  const chat = ctx.chat;
  const text = options.messageText || msg?.text || msg?.caption;
  if (!msg || !chat || !text) {
    return;
  }

  if (!ctx.from || !ctx.chatId) return;
  const senderId = ctx.from.id;
  const currentChatId = ctx.chatId;

  const startedAt = performance.now();
  await Promise.all([saveChat(chat), saveUser(ctx.from), saveUser(ctx.me)]);
  const existingResponse = await findFirstMessageRepo({
    chatId: BigInt(ctx.chatId),
    replyToMessageId: BigInt(msg.message_id),
    senderId: BigInt(ctx.me.id),
    messageType: 'TEXT',
  });
  if (existingResponse) {
    logger.info(
      {
        event: 'ai.response_duplicate_skipped',
        sourceMessageId: msg.message_id,
        responseMessageId: Number(existingResponse.id),
      },
      'Skipped duplicate AI response after persisted delivery',
    );
    return;
  }
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  const quotaReservation = await reserveQuota({
    userId: ctx.from.id,
    chatId: ctx.chatId,
    isGroup,
    kind: 'PRIMARY_RESPONSE',
  });
  const model = quotaReservation.allowed ? chatModel : liteChatModel;
  const trackAnalytics = options.persistResponse !== false;
  if (trackAnalytics) recordAiAttempt();
  logger.info(
    {
      event: 'ai.response_started',
      modelTier: quotaReservation.allowed ? 'primary' : 'lite',
      quotaAllowed: quotaReservation.allowed,
      ephemeral: Boolean(options.ephemeralReceiverUserId),
    },
    'AI response started',
  );
  let completed = false;

  let streamSink: TelegramStreamSink | undefined;
  let streamFinalized = false;
  const sendTyping = () => {
    void ctx.replyWithChatAction('typing').catch((error) => {
      logger.error(
        { event: 'telegram.typing_failed', err: error },
        'Failed to update Telegram typing status',
      );
    });
  };
  const typingInterval =
    options.ephemeralReceiverUserId || options.typingStatus
      ? undefined
      : setInterval(sendTyping, 5000);

  try {
    if (
      !quotaReservation.allowed &&
      (await shouldSendLimitNotice({
        userId: ctx.from.id,
        chatId: ctx.chatId,
        kind: 'LITE_FALLBACK',
      }))
    ) {
      const session = await createPurchaseSession({
        userId: ctx.from.id,
        beneficiaryChatId: ctx.chatId,
      });
      const username = ctx.me.username;
      const subscribeUrl = username
        ? `https://t.me/${username}?start=buy_${session.token}`
        : undefined;
      const ephemeralMessageId = ctx.msg?.ephemeral_message_id;
      await ctx.reply(
        'Лимит основной модели на сегодня закончился — отвечаю через более простую модель. Подписка вернёт повышенные лимиты.',
        {
          ...(isGroup && ephemeralMessageId
            ? {
                receiver_user_id: ctx.from.id,
                reply_parameters: { ephemeral_message_id: ephemeralMessageId },
              }
            : {}),
          ...(subscribeUrl
            ? {
                reply_markup: new InlineKeyboard().url(
                  'Подписка',
                  subscribeUrl,
                ),
              }
            : {}),
        },
      );
    }

    if (!options.ephemeralReceiverUserId && !options.typingStatus) {
      sendTyping();
    }
    streamSink = await TelegramStreamSink.create(ctx, {
      ephemeralReceiverUserId: options.ephemeralReceiverUserId,
    });

    if (options.resolveContext && ctx.from && ctx.chatId) {
      const replyText =
        msg.reply_to_message?.text?.trim() ||
        msg.reply_to_message?.caption?.trim();
      const query = replyText ? `Q: ${replyText}\n\nA: ${text}` : text;
      const resolvedContext = await searchContext(
        query,
        ctx.from.id,
        ctx.chatId,
        chat.type === 'private',
        trackAnalytics,
      );
      userContext = resolvedContext.userContext;
      chatContext = resolvedContext.chatContext;
    }

    const rawMessages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string | Array<unknown>;
    }> = [];

    let list: Awaited<ReturnType<typeof getThread>> = [];

    const replyToMessage = options.ephemeralReceiverUserId
      ? null
      : await findMessageWithSelectRepo(
          BigInt(ctx.chatId ?? 0),
          BigInt(msg.message_id),
          {
            id: true,
            sessionId: true,
          },
        );

    const sessionId = replyToMessage?.sessionId || sessionIdGenerator();

    if (msg.reply_to_message) {
      if (replyToMessage?.sessionId) {
        const sessionThread = await getThreadBySessionId(
          ctx.chatId ?? 0,
          BigInt(msg.reply_to_message.message_id),
          replyToMessage.sessionId,
        );
        list =
          sessionThread.length > 0 && !sessionThread[0]?.replyToMessageId
            ? sessionThread
            : await getThread(
                ctx.chatId ?? 0,
                BigInt(msg.reply_to_message.message_id),
              );
      } else {
        list = await getThread(
          ctx.chatId ?? 0,
          BigInt(msg.reply_to_message.message_id),
        );
      }
    }

    // Группируем последовательные сообщения
    let currentMessages: typeof list = [];
    let currentRole: 'assistant' | 'user' | null = null;

    const pushMessages = () => {
      if (currentMessages.length === 0) return;

      if (currentRole === 'assistant') {
        rawMessages.push({
          role: 'assistant',
          content: currentMessages[0].summary ?? currentMessages[0].text ?? '',
        });
      } else if (currentRole === 'user') {
        rawMessages.push({
          role: 'user',
          content: JSON.stringify(
            currentMessages.map((msg) => ({
              type: msg.messageType,
              sender: msg.sender.userName,
              text:
                (msg.messageType === 'MEDIA'
                  ? 'Пользователь прислал фотографию, описание которой: '
                  : '') + (msg.summary || msg.text),
            })),
          ),
        });
      }

      currentMessages = [];
    };

    // Обрабатываем сообщения из истории
    list.forEach((msg) => {
      const role =
        msg.sender.userName === ctx.me.username ? 'assistant' : 'user';

      if (role !== currentRole) {
        pushMessages();
        currentRole = role;
      }

      currentMessages.push(msg);
    });

    // Добавляем оставшиеся сообщения из истории
    pushMessages();

    // Добавляем текущее сообщение пользователя
    rawMessages.push({
      role: 'user',
      content: JSON.stringify([
        ...(imageDescription
          ? [
              {
                type: 'image',
                sender: ctx.from?.username,
                image:
                  'Пользователь прислал фотографию, описание которой: ' +
                  imageDescription,
              },
            ]
          : []),
        {
          type: 'text',
          sender: ctx.from?.username,
          text,
        },
      ]),
    });

    const mentionedIds = await extractMentionedUserIds(ctx);

    const allUserIds = [
      ...new Set(
        [
          ctx.from?.id,
          ...list.map((x) => Number(x.sender.id)),
          ...mentionedIds,
        ].filter((x): x is number => x !== undefined),
      ),
    ];

    const [userList, allMemories] = await Promise.all([
      findManyUsersRepo({
        id: { in: allUserIds.map(BigInt) },
      }),
      getRecentMemoriesForUsers([senderId], currentChatId, 10).catch(
        () => new Map<number, string[]>(),
      ),
    ]);

    const userFactsPromises = userList.map((user) =>
      getTopUserFacts(
        user.id,
        user.id === BigInt(senderId)
          ? {}
          : { sourceChatId: BigInt(currentChatId) },
      ),
    );
    const userFactsResults = await Promise.all(userFactsPromises);

    const recentChatContext =
      options.includeRecentChatContext &&
      !options.readOnlyTools &&
      options.persistResponse !== false &&
      !msg.reply_to_message
        ? await getRecentPublicChatContext(ctx.chatId, msg.message_id)
        : null;
    const memoriesByUser = userList
      .filter((user) => user.id === BigInt(senderId))
      .map((user) => {
        const userMemories = allMemories.get(Number(user.id)) || [];
        if (userMemories.length === 0) return null;
        const userIdentifier = user.userName
          ? `@${user.userName}`
          : user.firstName || '';
        return {
          user: userIdentifier,
          memories: userMemories,
        };
      })
      .filter((value): value is { user: string; memories: string[] } =>
        Boolean(value),
      );
    const selectedRules = chooseChatGenerationRules();
    const threadRules = renderChatGenerationRules(selectedRules, [
      richMarkdownInstructions,
    ]);
    const currentUserMessage = rawMessages.at(-1) as ModelMessage;
    let contextResult: Awaited<ReturnType<typeof buildAiThreadContext>>;
    if (options.persistResponse === false) {
      const instructions = buildChatGenerationInstructions(threadRules);
      contextResult = {
        instructions,
        messages: rawMessages as ModelMessage[],
        telemetry: {
          promptVersion: 3,
          promptHash: 'unavailable',
          threadId: sessionId,
          cacheBoundary: 0,
          stablePrefixCharacters: instructions.length,
          dynamicCharacters: JSON.stringify(rawMessages).length,
          providerCacheRead: 'unavailable',
          providerCacheWrite: 'unavailable',
        },
      };
    } else {
      try {
        contextResult = await buildAiThreadContext({
          threadId: sessionId,
          chatId: BigInt(ctx.chatId),
          rootMessageId: BigInt(
            msg.reply_to_message?.message_id ?? msg.message_id,
          ),
          turnId: String(msg.message_id),
          rules: threadRules,
          userContext: {
            users: userList.map((user, index) => ({
              id: user.id.toString(),
              firstName: user.firstName,
              lastName: user.lastName,
              userName: user.userName,
              metaInfo: convertFactsToMetaInfo(userFactsResults[index]),
            })),
            memories: memoriesByUser,
          },
          retrievalContext:
            userContext || chatContext || recentChatContext
              ? { userContext, chatContext, recentChatContext }
              : undefined,
          time: formatAiContextTime(),
          currentUserMessage,
          legacyHistory: rawMessages.slice(0, -1) as ModelMessage[],
          messageId: BigInt(msg.message_id),
          privateMode: options.privateMode,
        });
      } catch (error) {
        logger.error(
          { event: 'ai.context_build_failed', err: error },
          'Failed to build durable AI context; using current history',
        );
        const instructions = buildChatGenerationInstructions(threadRules);
        contextResult = {
          instructions,
          messages: rawMessages as ModelMessage[],
          telemetry: {
            promptVersion: 3,
            promptHash: 'unavailable',
            threadId: sessionId,
            cacheBoundary: 0,
            stablePrefixCharacters: instructions.length,
            dynamicCharacters: JSON.stringify(rawMessages).length,
            providerCacheRead: 'unavailable',
            providerCacheWrite: 'unavailable',
          },
        };
      }
    }
    const messages: ModelMessage[] = [
      { role: 'system', content: contextResult.instructions },
      ...contextResult.messages,
    ];

    const generate = (observation?: LangfuseSpan) =>
      chatGeneration(
        messages,
        observation,
        ctx,
        (streamedText) => streamSink?.update(streamedText),
        {
          readOnlyTools: options.readOnlyTools,
          allowChatHistory:
            options.includeRecentChatContext === true &&
            options.persistResponse !== false,
          maxOutputTokens: options.ephemeralReceiverUserId ? 4096 : undefined,
          model,
        },
      );
    const result =
      options.persistResponse === false
        ? await generate()
        : await withAiObservation(
            'chat-generation',
            {
              sessionId,
              userId: ctx.from?.id?.toString(),
              metadata: contextResult.telemetry,
            },
            generate,
          );

    // logger.debug(
    //   `AI request for user ${JSON.stringify({
    //     ...userList[0],
    //     id: Number(userList[0].id),
    //   })} in chat ${JSON.stringify(ctx.chat)}: ${JSON.stringify(
    //     rawMessages,
    //   )} \n response: "${result}"`,
    // );

    if (result) {
      clearInterval(typingInterval);
      const reply = await streamSink.finish(result);
      streamFinalized = true;
      completed = true;
      if (trackAnalytics) {
        recordAiSuccess(performance.now() - startedAt);
      }
      logger.info(
        {
          event: 'ai.response_completed',
          durationMs: Math.round(performance.now() - startedAt),
          responseMessageId: reply.message_id,
          persisted: options.persistResponse !== false,
        },
        'AI response completed',
      );

      if (options.persistResponse === false) {
        return;
      }

      try {
        await saveMessage({
          id: BigInt(reply.message_id),
          chatId: BigInt(ctx.chatId ?? 0),
          senderId: BigInt(reply.from?.id ?? 0),
          sessionId,
          replyToMessageId: ctx.msg?.message_id
            ? BigInt(ctx.msg.message_id)
            : undefined,
          sentAt: new Date(reply.date * 1000),
          messageType: 'TEXT',
          text: result.toString(),
          private: options.privateMode ?? false,
          modelId: model.modelId,
        });
        try {
          await appendAiThreadAssistantEvent(
            sessionId,
            String(msg.message_id),
            result.toString(),
            {
              chatId: BigInt(ctx.chatId ?? 0),
              messageId: BigInt(reply.message_id),
            },
          );
        } catch (err) {
          logger.error(
            { event: 'ai.context_assistant_event_persist_failed', err },
            'Failed to persist AI assistant context event',
          );
        }
      } catch (err) {
        logger.error(
          {
            event: 'message.response_persist_failed',
            err,
            responseMessageId: reply.message_id,
          },
          'Failed to persist AI response',
        );
      }
    } else if (trackAnalytics) {
      recordAiFailure(performance.now() - startedAt);
    }
  } catch (err) {
    if (trackAnalytics && !completed) {
      recordAiFailure(performance.now() - startedAt);
    }
    logger.error(
      {
        event: 'ai.response_failed',
        err,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'AI response failed',
    );
    throw err;
  } finally {
    clearInterval(typingInterval);
    if (!completed) {
      await releaseQuota(quotaReservation).catch((err) =>
        logger.error(
          { event: 'quota.response_release_failed', err },
          'Failed to release response quota',
        ),
      );
    }
    if (!streamFinalized) {
      await streamSink?.cancel();
    }
  }
};
