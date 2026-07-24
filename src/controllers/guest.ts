import type { Message } from '@grammyjs/types';
import type { ModelMessage } from 'ai';
import { format } from 'date-fns';
import { Composer } from 'grammy';
import { chatGeneration } from '../ai/chat-generation';
import { langfuse } from '../ai/langfuse';
import {
  createRichMessage,
  richMarkdownInstructions,
} from '../ai/rich-message';
import type { BotContext } from '../bot';
import { logger } from '../logger';

const guestAnswerId = 'phoronis-guest-answer';
const guestAnswerTitle = 'Ответ Ио';
const maxTextMessageLength = 4096;

export const guestController = new Composer<BotContext>();

export function extractGuestQuery(text: string, botUsername: string): string {
  return text.replace(new RegExp(`@${botUsername}\\b`, 'giu'), '').trim();
}

function getMessageText(message: Message | undefined): string {
  return message?.text?.trim() || message?.caption?.trim() || '';
}

function truncateText(text: string, maxLength: number): string {
  return [...text].slice(0, maxLength).join('');
}

async function answerGuestMessage(ctx: BotContext, markdown: string) {
  const richMessage = createRichMessage(markdown);

  if (richMessage) {
    try {
      return await ctx.answerGuestQuery({
        type: 'article',
        id: guestAnswerId,
        title: guestAnswerTitle,
        input_message_content: { rich_message: richMessage },
      });
    } catch (error) {
      logger.warn(error, 'Failed to send rich guest response');
    }
  }

  return ctx.answerGuestQuery({
    type: 'article',
    id: guestAnswerId,
    title: guestAnswerTitle,
    input_message_content: {
      message_text: truncateText(markdown, maxTextMessageLength),
    },
  });
}

export async function handleGuestMessage(ctx: BotContext): Promise<void> {
  const message = ctx.guestMessage;
  const botUsername = ctx.me.username;
  if (!message?.guest_query_id || !botUsername) return;

  const query = extractGuestQuery(getMessageText(message), botUsername);
  const referencedMessage = getMessageText(message.reply_to_message);

  if (!query && !referencedMessage) {
    await answerGuestMessage(
      ctx,
      'Упомяни меня вместе с вопросом или ответь на сообщение, которое нужно разобрать.',
    );
    return;
  }

  const prompt = await langfuse.getPrompt('chat-generation');
  const compiledPrompt = prompt.compile({
    users: '[]',
    rules: [
      '- Ты отвечаешь как гостевой бот и видишь только переданное сообщение и явную цитату',
      '- Не утверждай, что видишь историю или участников чата',
      richMarkdownInstructions,
    ].join('\n'),
    time: format(new Date(), 'dd.MM.yyyy HH:mm:ss'),
  });

  const content = [
    referencedMessage
      ? { type: 'reference', text: referencedMessage }
      : undefined,
    { type: 'text', text: query || 'Ответь на сообщение из reference' },
  ].filter(Boolean);

  const messages: ModelMessage[] = [
    { role: 'system', content: compiledPrompt },
    { role: 'user', content: JSON.stringify(content) },
  ];

  const trace = langfuse.trace({
    name: 'guest-generation',
    sessionId: message.guest_query_id,
    userId: message.from?.id.toString() ?? null,
    metadata: { chatType: message.chat.type },
  });

  const result = await chatGeneration(messages, trace, undefined, undefined, {
    readOnlyTools: true,
  });

  if (result) {
    await answerGuestMessage(ctx, result);
  }
}

guestController.on('guest_message', async (ctx) => {
  try {
    await handleGuestMessage(ctx);
  } catch (error) {
    logger.error(error, 'Failed to process guest message');
    try {
      await answerGuestMessage(
        ctx,
        'Не получилось ответить. Попробуй ещё раз.',
      );
    } catch (replyError) {
      logger.error(replyError, 'Failed to send guest error response');
    }
  }
});
