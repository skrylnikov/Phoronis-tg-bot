import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

vi.mock('../logger', () => ({
  logger: {
    error: vi.fn(),
  },
}));

import { collectStreamedText } from '../ai/stream-text';
import { TelegramStreamSink } from '../ai/telegram-stream';

interface TestContext {
  context: BotContext;
  deleteMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  replyWithDraft: ReturnType<typeof vi.fn>;
}

function createContext(
  type: 'private' | 'group' | 'supergroup',
  isTopic = false,
): TestContext {
  const replyWithDraft = vi.fn().mockResolvedValue(true);
  const reply = vi.fn().mockResolvedValue({
    message_id: 100,
    date: 10,
    from: { id: 999 },
  });
  const editMessageText = vi.fn().mockResolvedValue(true);
  const deleteMessage = vi.fn().mockResolvedValue(true);

  const context = {
    chat: { id: -100, type },
    chatId: -100,
    msg: {
      message_id: 42,
      is_topic_message: isTopic,
      message_thread_id: isTopic ? 77 : undefined,
    },
    update: { update_id: 7 },
    reply,
    replyWithDraft,
    api: {
      deleteMessage,
      editMessageText,
    },
  } as unknown as BotContext;

  return {
    context,
    deleteMessage,
    editMessageText,
    reply,
    replyWithDraft,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('TelegramStreamSink', () => {
  it('uses native drafts in private chats and sends a persistent final reply', async () => {
    const testContext = createContext('private', true);
    const sink = await TelegramStreamSink.create(testContext.context);

    sink.update('Первая часть');
    sink.update('Первая часть ответа');
    await vi.advanceTimersByTimeAsync(1000);

    expect(testContext.replyWithDraft).toHaveBeenCalledTimes(2);
    expect(testContext.replyWithDraft).toHaveBeenNthCalledWith(1, '', {
      draft_id: 7,
      message_thread_id: 77,
    });
    expect(testContext.replyWithDraft).toHaveBeenNthCalledWith(
      2,
      'Первая часть ответа',
      { draft_id: 7, message_thread_id: 77 },
    );

    const reply = await sink.finish('Готово', '*Готово*');

    expect(reply.message_id).toBe(100);
    expect(testContext.reply).toHaveBeenCalledWith('*Готово*', {
      message_thread_id: 77,
      parse_mode: 'MarkdownV2',
      reply_to_message_id: 42,
    });
  });

  it('edits one group message and limits intermediate updates to once per second', async () => {
    const testContext = createContext('group');
    const sink = await TelegramStreamSink.create(testContext.context);

    expect(testContext.reply).toHaveBeenCalledOnce();
    expect(testContext.reply).toHaveBeenCalledWith('Думаю…', {
      reply_to_message_id: 42,
    });

    sink.update('A');
    sink.update('AB');
    await vi.advanceTimersByTimeAsync(999);
    expect(testContext.editMessageText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(testContext.editMessageText).toHaveBeenCalledTimes(1);
    expect(testContext.editMessageText).toHaveBeenLastCalledWith(
      -100,
      100,
      'AB',
    );

    sink.update('ABC');
    await vi.advanceTimersByTimeAsync(999);
    expect(testContext.editMessageText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(testContext.editMessageText).toHaveBeenCalledTimes(2);

    const reply = await sink.finish('Финал', '*Финал*');
    expect(reply.message_id).toBe(100);
    expect(testContext.editMessageText).toHaveBeenLastCalledWith(
      -100,
      100,
      '*Финал*',
      { parse_mode: 'MarkdownV2' },
    );
    expect(testContext.reply).toHaveBeenCalledTimes(1);
  });

  it('caps draft previews at the Telegram message limit', async () => {
    const testContext = createContext('private');
    const sink = await TelegramStreamSink.create(testContext.context);

    sink.update('x'.repeat(5000));
    await vi.advanceTimersByTimeAsync(1000);

    expect(testContext.replyWithDraft.mock.calls[1]?.[0]).toHaveLength(4096);
  });

  it('sends the final private reply when native drafts are unavailable', async () => {
    const testContext = createContext('private');
    testContext.replyWithDraft.mockRejectedValue(new Error('draft failed'));
    const sink = await TelegramStreamSink.create(testContext.context);

    sink.update('Промежуточный текст');
    await vi.advanceTimersByTimeAsync(1000);
    const reply = await sink.finish('Финал', '*Финал*');

    expect(testContext.replyWithDraft).toHaveBeenCalledTimes(1);
    expect(testContext.reply).toHaveBeenCalledOnce();
    expect(reply.message_id).toBe(100);
  });

  it('falls back to a new final reply when a group message cannot be edited', async () => {
    const testContext = createContext('supergroup');
    testContext.editMessageText.mockRejectedValue(new Error('edit failed'));
    const sink = await TelegramStreamSink.create(testContext.context);

    const reply = await sink.finish('Финал', '*Финал*');

    expect(testContext.editMessageText).toHaveBeenCalledTimes(2);
    expect(testContext.reply).toHaveBeenCalledTimes(2);
    expect(reply.message_id).toBe(100);
  });

  it('removes an unfinished group placeholder and cancels pending updates', async () => {
    const testContext = createContext('group');
    const sink = await TelegramStreamSink.create(testContext.context);

    sink.update('Не должно появиться');
    await sink.cancel();
    await vi.advanceTimersByTimeAsync(1000);

    expect(testContext.editMessageText).not.toHaveBeenCalled();
    expect(testContext.deleteMessage).toHaveBeenCalledWith(-100, 100);
  });
});

describe('collectStreamedText', () => {
  it('ignores non-text phases and emits accumulated text after tool-call pauses', async () => {
    const updates: string[] = [];
    async function* textStream() {
      yield '';
      await Promise.resolve();
      yield 'После ';
      yield 'инструмента';
    }

    const result = await collectStreamedText(
      textStream(),
      Promise.resolve('После инструмента'),
      (text) => {
        updates.push(text);
      },
    );

    expect(updates).toEqual(['После ', 'После инструмента']);
    expect(result).toBe('После инструмента');
  });
});
