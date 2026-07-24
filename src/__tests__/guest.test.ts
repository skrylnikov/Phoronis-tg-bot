import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const { chatGeneration, compile, getPrompt, trace } = vi.hoisted(() => ({
  chatGeneration: vi.fn().mockResolvedValue('## Готово'),
  compile: vi.fn().mockReturnValue('system prompt'),
  getPrompt: vi.fn(),
  trace: vi.fn().mockReturnValue({ update: vi.fn() }),
}));

getPrompt.mockResolvedValue({ compile });

vi.mock('../ai/chat-generation', () => ({ chatGeneration }));
vi.mock('../ai/langfuse', () => ({
  langfuse: { getPrompt, trace },
}));
vi.mock('../logger', () => ({
  logger: { warn: vi.fn() },
}));

import { extractGuestQuery, handleGuestMessage } from '../controllers/guest';

function createContext(text: string, replyText?: string) {
  const answerGuestQuery = vi.fn().mockResolvedValue({
    inline_message_id: 'inline-1',
  });
  const context = {
    me: { id: 999, username: 'phoronis_bot' },
    guestMessage: {
      message_id: 0,
      guest_query_id: 'query-1',
      date: 1,
      chat: { id: -100, type: 'supergroup' },
      from: { id: 123 },
      text,
      reply_to_message: replyText
        ? {
            message_id: 42,
            date: 1,
            chat: { id: -100, type: 'supergroup' },
            text: replyText,
          }
        : undefined,
    },
    answerGuestQuery,
  } as unknown as BotContext;

  return { answerGuestQuery, context };
}

beforeEach(() => vi.clearAllMocks());

describe('guestController', () => {
  it('removes the bot mention from a guest query', () => {
    expect(extractGuestQuery('@Phoronis_Bot объясни это', 'phoronis_bot')).toBe(
      'объясни это',
    );
  });

  it('generates one read-only rich response with referenced context', async () => {
    const { answerGuestQuery, context } = createContext(
      '@phoronis_bot почему?',
      'Исходное сообщение',
    );

    await handleGuestMessage(context);

    expect(chatGeneration).toHaveBeenCalledWith(
      [
        { role: 'system', content: 'system prompt' },
        {
          role: 'user',
          content: JSON.stringify([
            { type: 'reference', text: 'Исходное сообщение' },
            { type: 'text', text: 'почему?' },
          ]),
        },
      ],
      expect.anything(),
      undefined,
      undefined,
      { readOnlyTools: true },
    );
    expect(answerGuestQuery).toHaveBeenCalledWith({
      type: 'article',
      id: 'phoronis-guest-answer',
      title: 'Ответ Ио',
      input_message_content: { rich_message: { markdown: '## Готово' } },
    });
  });

  it('answers with usage guidance when the query has no content', async () => {
    const { answerGuestQuery, context } = createContext('@phoronis_bot');

    await handleGuestMessage(context);

    expect(chatGeneration).not.toHaveBeenCalled();
    expect(answerGuestQuery).toHaveBeenCalledOnce();
  });
});
