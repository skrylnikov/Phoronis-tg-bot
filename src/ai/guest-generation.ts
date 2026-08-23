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
import { langfuse } from './langfuse';
import { richMarkdownInstructions } from './rich-message';
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
  if (!message || !ctx.from || !ctx.chatId || !ctx.chat) return null;

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

    const [userList, prompt, allMemories] = await Promise.all([
      findManyUsersRepo({ id: { in: allUserIds.map(BigInt) } }),
      langfuse.getPrompt('chat-generation'),
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
    const recentChatContextText = recentChatContext?.messages.length
      ? `\nСохранённый наблюдаемый контекст чата (это не полная история Telegram):\n${recentChatContext.messages
          .map(
            (item) =>
              `[${item.sender}, ${item.sentAt}, #${item.id}] ${item.content}`,
          )
          .join('\n')}${
          recentChatContext.truncated
            ? '\nКонтекст усечён; не утверждай, что видишь всю историю.'
            : ''
        }`
      : '';
    const memoriesByUser = userList
      .map((user) => {
        const memories = allMemories.get(Number(user.id)) || [];
        if (memories.length === 0) return null;
        const identifier = user.userName
          ? `@${user.userName}`
          : user.firstName || '';
        return `${identifier}:\n${memories.map((memory) => `- ${memory}`).join('\n')}`;
      })
      .filter((value): value is string => value !== null);

    const compiledPrompt = prompt.compile({
      users: JSON.stringify(
        userList.map((user, index) => ({
          id: user.id.toString(),
          firstName: user.firstName,
          lastName: user.lastName,
          userName: user.userName,
          metaInfo: convertFactsToMetaInfo(userFactsResults[index]),
        })),
      ),
      rules: [
        '- Используй tools когда это нужно',
        '- Ты отвечаешь в guest mode и видишь только сохранённую ботом публичную историю; не выдавай её за полную историю чата',
        richMarkdownInstructions,
        userContext && `\nUser context: "${userContext.join('", "')}"`,
        chatContext && `\nChat context: "${chatContext.join('", "')}"`,
        recentChatContextText,
        memoriesByUser.length > 0
          ? `\nИнформация из памяти:\n${memoriesByUser.join('\n\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      time: new Date()
        .toLocaleString('ru-RU', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
        .replace(',', ''),
    });

    const messages: ModelMessage[] = [
      { role: 'system', content: compiledPrompt },
      ...previousInteractions
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
        ]),
      {
        role: 'user',
        content: JSON.stringify([
          ...(referenceText
            ? [{ type: 'reference', text: referenceText }]
            : []),
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
      },
    ];

    const trace = langfuse.trace({
      name: 'guest-generation',
      sessionId: message.guest_query_id,
      userId: message.from?.id.toString() ?? null,
      metadata: { chatType: message.chat.type },
    });
    const result = await chatGeneration(messages, trace, ctx, undefined, {
      readOnlyTools: true,
      allowChatHistory: !privateMode && isGroup,
      allowChatHistoryReadOnly: true,
      model,
    });
    if (!result) return null;

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
