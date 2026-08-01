import type { ModelMessage } from 'ai';
import { format } from 'date-fns';
import { InlineKeyboard } from 'grammy';
import { unique } from 'remeda';
import type { BotContext } from '../bot';
import { sessionIdGenerator } from '../config';
import { prisma } from '../db';
import type { Message, User } from '../generated/prisma/client';
import { logger } from '../logger';
import {
  createPurchaseSession,
  releaseQuota,
  reserveQuota,
  saveChat,
  saveMessage,
  saveUser,
  shouldSendLimitNotice,
} from '../shared';
import { getRecentMemoriesForUsers } from '../tools/memory';
import { extractMentionedUserIds } from '../tools/shared/entities';
import { getTopUserFacts } from '../tools/user/fact-analyzer';
import { chatModel, liteChatModel } from './ai';
import { chatGeneration } from './chat-generation';
import { searchContext } from './embedding';
import { langfuse } from './langfuse';
import { richMarkdownInstructions } from './rich-message';
import { TelegramStreamSink } from './telegram-stream';
import { getRecentPublicChatContext } from './tools';

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
    const messages = await prisma.message.findMany({
      where: {
        chatId,
        id: {
          gte: messageId,
        },
      },
      include: {
        sender: true,
      },
      take: 10,
    });

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
  const messages = await prisma.message.findMany({
    where: {
      chatId,
      sessionId,
    },
    include: {
      sender: true,
    },
    take: 10,
  });

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
  readOnlyTools?: boolean;
  resolveContext?: boolean;
  includeRecentChatContext?: boolean;
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

  const startedAt = performance.now();
  await Promise.all([saveChat(chat), saveUser(ctx.from), saveUser(ctx.me)]);
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  const quotaReservation = await reserveQuota({
    userId: ctx.from.id,
    chatId: ctx.chatId,
    isGroup,
    kind: 'PRIMARY_RESPONSE',
  });
  const model = quotaReservation.allowed ? chatModel : liteChatModel;
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
  const typingInterval = options.ephemeralReceiverUserId
    ? undefined
    : setInterval(() => {
        void ctx.replyWithChatAction('typing').catch((error) => {
          logger.error(
            { event: 'telegram.typing_failed', err: error },
            'Failed to update Telegram typing status',
          );
        });
      }, 5000);

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

    if (!options.ephemeralReceiverUserId) {
      await ctx.replyWithChatAction('typing');
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
      : await prisma.message.findUnique({
          where: {
            chatId_id: {
              chatId: ctx.chatId ?? 0,
              id: msg.message_id,
            },
          },
          select: {
            id: true,
            sessionId: true,
          },
        });

    const sessionId = replyToMessage?.sessionId || sessionIdGenerator();

    if (msg.reply_to_message) {
      if (replyToMessage?.sessionId) {
        list = await getThreadBySessionId(
          ctx.chatId ?? 0,
          BigInt(msg.reply_to_message.message_id),
          replyToMessage.sessionId,
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

    const allUserIds = unique(
      [
        ctx.from?.id,
        ...list.map((x) => Number(x.sender.id)),
        ...mentionedIds,
      ].filter((x): x is number => x !== undefined),
    );

    const [userList, prompt, allMemories] = await Promise.all([
      prisma.user.findMany({
        where: {
          id: { in: allUserIds.map(BigInt) },
        },
      }),
      langfuse.getPrompt('chat-generation'),
      getRecentMemoriesForUsers(allUserIds, ctx.chatId ?? 0, 10).catch(
        () => new Map(),
      ),
    ]);

    const userFactsPromises = userList.map((user) => getTopUserFacts(user.id));
    const userFactsResults = await Promise.all(userFactsPromises);

    const trace =
      options.persistResponse === false
        ? undefined
        : langfuse.trace({
            name: 'chat-generation',
            sessionId,
            userId: ctx.from?.id?.toString() || null,
            metadata: {
              userName: [
                ctx.from?.username ? `@${ctx.from?.username}` : null,
                ctx.from?.first_name,
                ctx.from?.last_name,
              ]
                .filter(Boolean)
                .join(' '),
            },
          });

    const isHelpful = Math.random() < 0.3;
    const isUseUsername = Math.random() < 0.2;
    const isInterests = Math.random() < 0.1;
    const isShort = Math.random() < 0.5;
    const isFunny = !isHelpful && Math.random() < 0.1;

    const recentChatContext =
      options.includeRecentChatContext &&
      !options.readOnlyTools &&
      options.persistResponse !== false &&
      isGroup &&
      !msg.reply_to_message
        ? await getRecentPublicChatContext(ctx.chatId, msg.message_id)
        : null;
    const recentChatContextText = recentChatContext?.messages.length
      ? `\nСвежий контекст чата (сообщения непосредственно перед текущим запросом):\n${recentChatContext.messages
          .map(
            (message) =>
              `[${message.sender}, ${message.sentAt}, #${message.id}] ${message.content}`,
          )
          .join('\n')}${
          recentChatContext.truncated
            ? '\nКонтекст усечён по размеру; не утверждай, что видишь всю историю.'
            : ''
        }`
      : '';

    const compiledPrompt = prompt.compile({
      users: JSON.stringify(
        userList.map((x, i) => ({
          id: x.id.toString(),
          firstName: x.firstName,
          lastName: x.lastName,
          userName: x.userName,
          metaInfo: convertFactsToMetaInfo(userFactsResults[i]),
        })),
      ),
      rules: [
        '- Используй tools когда это нужно',
        richMarkdownInstructions,
        isShort && '- Отвечай кратко',
        isHelpful && '- Будь полезной и старайся помочь',
        isInterests &&
          '- Иногда предлагай пообщаться на интересные пользователю темы',
        isUseUsername &&
          '- В ответах если это уместно, иногда используй имя собеседника',
        isFunny && '- Отвечай с саркастическим юмором',
        userContext && `\nUser context: "${userContext.join('", "')}"`,
        chatContext && `\nChat context: "${chatContext.join('", "')}"`,
        recentChatContextText,
        (() => {
          const memoriesByUser = userList
            .map((user) => {
              const userMemories = allMemories.get(Number(user.id)) || [];
              if (userMemories.length === 0) return null;
              const userIdentifier = user.userName
                ? `@${user.userName}`
                : user.firstName || '';
              return `${userIdentifier}:\n${userMemories.map((m: string) => `- ${m}`).join('\n')}`;
            })
            .filter((m): m is string => m !== null);

          return memoriesByUser.length > 0
            ? `\nИнформация из памяти:\n${memoriesByUser.join('\n\n')}`
            : '';
        })(),
      ]
        .filter(Boolean)
        .join('\n'),

      time: format(new Date(), 'dd.MM.yyyy HH:mm:ss'),
    });

    const messages: ModelMessage[] = [
      {
        role: 'system',
        content: compiledPrompt,
      },
      ...(rawMessages as ModelMessage[]),
    ];

    const result = await chatGeneration(
      messages,
      trace,
      ctx,
      (streamedText) => streamSink?.update(streamedText),
      {
        readOnlyTools: options.readOnlyTools,
        allowChatHistory:
          options.includeRecentChatContext === true &&
          options.persistResponse !== false,
        model,
      },
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
          id: reply.message_id,
          chatId: ctx.chatId ?? 0,
          senderId: reply.from?.id ?? 0,
          replyToMessageId: ctx.msg?.message_id,
          sentAt: new Date(reply.date * 1000),
          messageType: 'TEXT',
          text: result.toString(),
        });
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
    }
  } catch (err) {
    logger.error(
      {
        event: 'ai.response_failed',
        err,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'AI response failed',
    );
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
