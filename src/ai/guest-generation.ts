import type { LangfuseSpan } from '@langfuse/tracing';
import type { ModelMessage } from 'ai';
import type { BotContext } from '../bot';
import {
  getRecentGuestInteractions,
  releaseQuota,
  reserveQuota,
} from '../domain';
import { extractMentionedUserIds } from '../domain/entities';
import { getRecentMemoriesForUsers } from '../domain/memory';
import { getTopUserFacts } from '../domain/user/fact-analyzer';
import { logger } from '../logger';
import { findManyUsersRepo } from '../repositories/user-repository';
import { chatModel, liteChatModel } from './ai';
import { chatGeneration } from './chat-generation';
import { searchAndIndexMessage } from './embedding';
import { withAiObservation } from './langfuse';
import { richMarkdownInstructions } from './rich-message';
import {
  appendAiThreadAssistantEvent,
  buildAiThreadContext,
  buildChatGenerationInstructions,
  formatAiContextTime,
  renderChatGenerationRules,
} from './thread-context';
import { getRecentPublicChatContext } from './tools';

function isGroupChat(ctx: BotContext): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

function convertFactsToMetaInfo(
  facts: Awaited<ReturnType<typeof getTopUserFacts>>,
) {
  return {
    interests: facts
      .filter((fact) => fact.type === 'INTEREST')
      .map((fact) => ({ value: fact.content, weight: fact.weight })),
    communication_style: facts
      .filter((fact) => fact.type === 'TEXT_STYLE')
      .map((fact) => ({ value: fact.content, weight: fact.weight })),
    notable_traits: facts
      .filter((fact) => fact.type === 'FACT')
      .map((fact) => ({ value: fact.content, weight: fact.weight })),
    topics: [],
    notes: [],
  };
}

export async function generateGuestResponse(input: {
  ctx: BotContext;
  text: string;
  referenceText?: string;
  imageDescription?: string;
  privateMode: boolean;
  messagePersisted: boolean;
}): Promise<string | null> {
  const { ctx, text, referenceText, imageDescription, privateMode } = input;
  const message = ctx.guestMessage;
  if (!message?.guest_query_id || !ctx.from || !ctx.chatId || !ctx.chat) {
    return null;
  }
  const guestQueryId = message.guest_query_id;

  const isGroup = isGroupChat(ctx);
  const reservation = await reserveQuota({
    userId: ctx.from.id,
    chatId: ctx.chatId,
    isGroup,
    kind: 'PRIMARY_RESPONSE',
  });
  const model = reservation.allowed ? chatModel : liteChatModel;
  let completed = false;

  try {
    const content = referenceText
      ? `Q: ${referenceText}\n\nA: ${text || 'Ответь на сообщение из reference'}`
      : text;
    let userContext: string[] | null = null;
    let chatContext: string[] | null = null;

    if (!privateMode && input.messagePersisted) {
      const resolvedContext = await searchAndIndexMessage(
        {
          messageId: message.message_id,
          chatId: ctx.chatId,
        },
        content,
        ctx.from.id,
        ctx.chat.type === 'private',
        false,
      );
      userContext = resolvedContext.userContext;
      chatContext = resolvedContext.chatContext;
    }

    const previousInteractions = privateMode
      ? []
      : await getRecentGuestInteractions(BigInt(ctx.chatId), 10);
    const mentionedIds = await extractMentionedUserIds(ctx).catch(() => []);
    const referenceUserId = message.reply_to_message?.from?.id;
    const allUserIds = [
      ...new Set(
        [ctx.from.id, referenceUserId, ...mentionedIds].filter(
          (id): id is number => id !== undefined,
        ),
      ),
    ];

    const [userList, allMemories] = await Promise.all([
      findManyUsersRepo({ id: { in: allUserIds.map(BigInt) } }),
      getRecentMemoriesForUsers(allUserIds, ctx.chatId, 10).catch(
        () => new Map<number, string[]>(),
      ),
    ]);
    const userFactsResults = await Promise.all(
      userList.map((user) => getTopUserFacts(user.id)),
    );

    const currentMessageId = message.message_id > 0 ? message.message_id : 0;
    const recentChatContext =
      !privateMode && isGroup && !referenceText
        ? await getRecentPublicChatContext(ctx.chatId, currentMessageId)
        : null;
    const memoriesByUser = userList
      .map((user) => {
        const memories = allMemories.get(Number(user.id)) || [];
        if (memories.length === 0) return null;
        const identifier = user.userName
          ? `@${user.userName}`
          : user.firstName || '';
        return { user: identifier, memories };
      })
      .filter((value): value is { user: string; memories: string[] } =>
        Boolean(value),
      );
    const previousMessages: ModelMessage[] = previousInteractions
      .slice()
      .reverse()
      .flatMap((interaction) => [
        {
          role: 'user' as const,
          content: JSON.stringify([
            ...(interaction.referenceText
              ? [{ type: 'reference', text: interaction.referenceText }]
              : []),
            { type: 'text', text: interaction.query },
          ]),
        },
        { role: 'assistant' as const, content: interaction.answer || '' },
      ]);
    const currentUserMessage: ModelMessage = {
      role: 'user',
      content: JSON.stringify([
        ...(referenceText ? [{ type: 'reference', text: referenceText }] : []),
        ...(imageDescription
          ? [
              {
                type: 'image',
                image:
                  'Пользователь прислал фотографию, описание которой: ' +
                  imageDescription,
              },
            ]
          : []),
        { type: 'text', text: text || 'Ответь на сообщение из reference' },
      ]),
    };
    const guestRules = renderChatGenerationRules(
      {
        short: false,
        helpful: false,
        interests: false,
        username: false,
        funny: false,
      },
      [
        '- Ты отвечаешь в guest mode и видишь только сохранённую ботом публичную историю; не выдавай её за полную историю чата',
        richMarkdownInstructions,
      ],
    );
    let contextResult: Awaited<ReturnType<typeof buildAiThreadContext>>;
    try {
      contextResult = await buildAiThreadContext({
        threadId: guestQueryId,
        chatId: BigInt(ctx.chatId),
        rootMessageId:
          message.message_id > 0 ? BigInt(message.message_id) : undefined,
        turnId: guestQueryId,
        rules: guestRules,
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
        legacyHistory: previousMessages,
        messageId:
          message.message_id > 0 ? BigInt(message.message_id) : undefined,
      });
    } catch (error) {
      logger.error(
        { event: 'guest.context_build_failed', err: error },
        'Failed to build durable guest AI context; using current history',
      );
      contextResult = {
        instructions: buildChatGenerationInstructions(guestRules),
        messages: [...previousMessages, currentUserMessage],
        telemetry: {
          promptVersion: 3,
          promptHash: 'unavailable',
          threadId: guestQueryId,
          cacheBoundary: 0,
          stablePrefixCharacters:
            buildChatGenerationInstructions(guestRules).length,
          dynamicCharacters: JSON.stringify([
            ...previousMessages,
            currentUserMessage,
          ]).length,
          providerCacheRead: 'unavailable',
          providerCacheWrite: 'unavailable',
        },
      };
    }

    const messages: ModelMessage[] = [
      { role: 'system', content: contextResult.instructions },
      ...contextResult.messages,
    ];
    const result = await withAiObservation(
      'guest-generation',
      {
        sessionId: guestQueryId,
        userId: message.from?.id.toString(),
        metadata: { chatType: message.chat.type, ...contextResult.telemetry },
      },
      (observation: LangfuseSpan) =>
        chatGeneration(messages, observation, ctx, undefined, {
          readOnlyTools: true,
          allowChatHistory: !privateMode && isGroup,
          allowChatHistoryReadOnly: true,
          model,
        }),
    );
    if (!result) return null;

    await appendAiThreadAssistantEvent(
      guestQueryId,
      guestQueryId,
      result,
    ).catch((error) =>
      logger.error(
        { event: 'guest.context_assistant_event_persist_failed', err: error },
        'Failed to persist guest assistant context event',
      ),
    );

    completed = true;
    return result;
  } finally {
    if (!completed) {
      await releaseQuota(reservation).catch((error) =>
        logger.error(
          { event: 'quota.guest_response_release_failed', err: error },
          'Failed to release guest response quota',
        ),
      );
    }
  }
}
