import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const {
  answerGuestQuery,
  claimGuestInteraction,
  generateGuestResponse,
  markGuestInteractionAnswered,
  prisma,
} = vi.hoisted(() => ({
  answerGuestQuery: vi
    .fn()
    .mockResolvedValue({ inline_message_id: 'inline-1' }),
  claimGuestInteraction: vi.fn().mockResolvedValue({
    kind: 'claimed',
    id: 'interaction-1',
  }),
  generateGuestResponse: vi.fn().mockResolvedValue('## Готово'),
  markGuestInteractionAnswered: vi.fn().mockResolvedValue(undefined),
  prisma: {
    chat: {
      findUnique: vi.fn().mockResolvedValue({ privateModeEnabled: false }),
    },
    message: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('../ai/guest-generation', () => ({ generateGuestResponse }));
vi.mock('../db', () => ({ prisma }));
vi.mock('../shared', () => ({
  claimGuestInteraction,
  markGuestInteractionAnswered,
  markGuestInteractionFailed: vi.fn().mockResolvedValue(undefined),
  releaseQuota: vi.fn().mockResolvedValue(undefined),
  reserveQuota: vi.fn().mockResolvedValue({ allowed: true }),
  saveChat: vi.fn().mockResolvedValue(undefined),
  saveMessage: vi.fn().mockResolvedValue(undefined),
  saveUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../ai/image-description', () => ({
  describeTelegramPhoto: vi.fn(),
}));
vi.mock('../tools/user/message-analyzer', () => ({
  analyzeUserMessages: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../logger', () => ({
  logger: { warn: vi.fn() },
}));

import { extractGuestQuery, handleGuestMessage } from '../controllers/guest';

function createContext(text: string, replyText?: string) {
  const context = {
    me: { id: 999, username: 'phoronis_bot' },
    from: { id: 123 },
    chatId: -100,
    chat: { id: -100, type: 'supergroup', title: 'Test' },
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

    expect(generateGuestResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'почему?',
        referenceText: 'Исходное сообщение',
        privateMode: false,
      }),
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

    expect(generateGuestResponse).not.toHaveBeenCalled();
    expect(answerGuestQuery).toHaveBeenCalledOnce();
  });
});
