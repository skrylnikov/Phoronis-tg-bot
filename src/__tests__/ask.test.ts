import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const { aiController } = vi.hoisted(() => ({
  aiController: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../ai', () => ({ aiController }));

import { askController, extractAskQuestion } from '../controllers/ask';

function createContext(
  type: 'private' | 'group' | 'supergroup',
  text: string,
): { context: BotContext; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue({ message_id: 1, date: 1 });
  return {
    context: {
      chat: { id: -100, type },
      chatId: -100,
      from: { id: 123 },
      msg: { message_id: 0, ephemeral_message_id: 321, date: 1, text },
      reply,
    } as unknown as BotContext,
    reply,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('askController', () => {
  it('extracts plain and addressed command text', () => {
    expect(extractAskQuestion('/ask вопрос')).toBe('вопрос');
    expect(extractAskQuestion('/ask@phoronis_bot   вопрос')).toBe('вопрос');
  });

  it('starts ephemeral read-only AI without persistence', async () => {
    const { context, reply } = createContext('supergroup', '/ask секрет');

    await askController(context);

    expect(reply).not.toHaveBeenCalled();
    expect(aiController).toHaveBeenCalledWith(
      context,
      undefined,
      undefined,
      undefined,
      {
        messageText: 'секрет',
        ephemeralReceiverUserId: 123,
        persistResponse: false,
        readOnlyTools: true,
        resolveContext: true,
      },
    );
  });

  it('sends ephemeral usage for an empty group command', async () => {
    const { context, reply } = createContext('group', '/ask');

    await askController(context);

    expect(reply).toHaveBeenCalledWith('Использование: /ask ваш вопрос', {
      receiver_user_id: 123,
      reply_parameters: { ephemeral_message_id: 321 },
    });
    expect(aiController).not.toHaveBeenCalled();
  });

  it('rejects the command in private chats', async () => {
    const { context, reply } = createContext('private', '/ask вопрос');

    await askController(context);

    expect(reply).toHaveBeenCalledWith(
      'Команда /ask доступна только в группах.',
    );
    expect(aiController).not.toHaveBeenCalled();
  });
});
