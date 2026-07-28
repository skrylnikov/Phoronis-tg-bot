import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

vi.mock('../logger', () => ({
  logger: { error: vi.fn() },
}));

import { collectStreamedText } from '../ai/stream-text';
import { TelegramStreamSink } from '../ai/telegram-stream';

interface TestContext {
  context: BotContext;
  deleteEphemeralMessage: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  editEphemeralMessageText: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  replyWithDraft: ReturnType<typeof vi.fn>;
  replyWithRichMessage: ReturnType<typeof vi.fn>;
  replyWithRichMessageDraft: ReturnType<typeof vi.fn>;
}

function createContext(
  type: 'private' | 'group' | 'supergroup',
  isTopic = false,
): TestContext {
  const replyWithRichMessageDraft = vi.fn().mockResolvedValue(true);
  const replyWithRichMessage = vi.fn().mockResolvedValue({
    message_id: 100,
    date: 10,
    from: { id: 999 },
  });
  const reply = vi.fn().mockImplementation((_text, options) =>
    Promise.resolve({
      message_id: options?.receiver_user_id ? 0 : 100,
      ephemeral_message_id: options?.receiver_user_id ? 501 : undefined,
      date: 10,
      from: { id: 999 },
    }),
  );
  const replyWithDraft = vi.fn().mockResolvedValue(true);
  const editMessageText = vi.fn().mockResolvedValue(true);
  const editEphemeralMessageText = vi.fn().mockResolvedValue(true);
  const deleteMessage = vi.fn().mockResolvedValue(true);
  const deleteEphemeralMessage = vi.fn().mockResolvedValue(true);

  const context = {
    chat: { id: -100, type },
    chatId: -100,
    msg: {
      message_id: 42,
      ephemeral_message_id: 321,
      is_topic_message: isTopic,
      message_thread_id: isTopic ? 77 : undefined,
    },
    update: { update_id: 7 },
    reply,
    replyWithDraft,
    replyWithRichMessage,
    replyWithRichMessageDraft,
    api: {
      deleteEphemeralMessage,
      deleteMessage,
      editEphemeralMessageText,
      editMessageText,
    },
  } as unknown as BotContext;

  return {
    context,
    deleteEphemeralMessage,
    deleteMessage,
    editEphemeralMessageText,
    editMessageText,
    reply,
    replyWithDraft,
    replyWithRichMessage,
    replyWithRichMessageDraft,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('TelegramStreamSink', () => {
  it('streams legacy drafts in private chats and sends a rich reply when needed', async () => {
    const testContext = createContext('private', true);
    const sink = await TelegramStreamSink.create(testContext.context);

    sink.update('Первая часть ответа');
    await vi.advanceTimersByTimeAsync(1000);

    expect(testContext.replyWithDraft).toHaveBeenNthCalledWith(1, 'Думаю…', {
      draft_id: 7,
      message_thread_id: 77,
    });
    expect(testContext.replyWithDraft).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      {
        draft_id: 7,
        message_thread_id: 77,
        parse_mode: 'MarkdownV2',
      },
    );

    await sink.finish('## Готово');
    expect(testContext.replyWithRichMessage).toHaveBeenCalledWith(
      { markdown: '## Готово' },
      {
        message_thread_id: 77,
        reply_parameters: { message_id: 42 },
      },
    );
  });

  it('edits a rich group message at most once per second', async () => {
    const testContext = createContext('group');
    const sink = await TelegramStreamSink.create(testContext.context);

    expect(testContext.reply).toHaveBeenCalledWith('Думаю…', {
      reply_parameters: { message_id: 42 },
    });

    sink.update('A');
    sink.update('## AB');
    await vi.advanceTimersByTimeAsync(999);
    expect(testContext.editMessageText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(testContext.editMessageText).toHaveBeenLastCalledWith(-100, 100, {
      markdown: '## AB',
    });
  });

  it('retries a group update after incomplete legacy Markdown is rejected', async () => {
    const testContext = createContext('group');
    testContext.editMessageText
      .mockRejectedValueOnce(new Error("can't parse entities"))
      .mockResolvedValue(true);
    const sink = await TelegramStreamSink.create(testContext.context);

    sink.update('```ts');
    await vi.advanceTimersByTimeAsync(1000);
    sink.update('```ts\nconst answer = 42;\n```');
    await vi.advanceTimersByTimeAsync(1000);

    expect(testContext.editMessageText).toHaveBeenLastCalledWith(
      -100,
      100,
      expect.any(String),
      { parse_mode: 'MarkdownV2' },
    );
  });

  it('keeps /ask replies ephemeral and formatted with MarkdownV2', async () => {
    const testContext = createContext('supergroup');
    const sink = await TelegramStreamSink.create(testContext.context, {
      ephemeralReceiverUserId: 123,
    });

    sink.update('Черновик');
    await vi.advanceTimersByTimeAsync(1000);
    await sink.finish('*Финал*');

    expect(testContext.editEphemeralMessageText).toHaveBeenLastCalledWith(
      -100,
      123,
      501,
      expect.any(String),
      { parse_mode: 'MarkdownV2' },
    );
    expect(testContext.editMessageText).not.toHaveBeenCalled();
  });

  it('uses MarkdownV2 when rich content contains external media', async () => {
    const testContext = createContext('group');
    const sink = await TelegramStreamSink.create(testContext.context);
    await sink.finish('![](https://example.com/photo.jpg)');

    expect(testContext.editMessageText).toHaveBeenLastCalledWith(
      -100,
      100,
      expect.any(String),
      { parse_mode: 'MarkdownV2' },
    );
  });

  it('caps rich drafts at 32768 characters', async () => {
    const testContext = createContext('private');
    const sink = await TelegramStreamSink.create(testContext.context);

    sink.update(`## Заголовок\n\n${'x'.repeat(40_000)}`);
    await vi.advanceTimersByTimeAsync(1000);

    expect(
      testContext.replyWithRichMessageDraft.mock.calls[0]?.[0].markdown,
    ).toHaveLength(32_768);
  });

  it('uses MarkdownV2 for a simple final reply', async () => {
    const testContext = createContext('private');
    const sink = await TelegramStreamSink.create(testContext.context);

    await sink.finish('*Готово*');

    expect(testContext.replyWithRichMessage).not.toHaveBeenCalled();
    expect(testContext.reply).toHaveBeenLastCalledWith(expect.any(String), {
      parse_mode: 'MarkdownV2',
      reply_to_message_id: 42,
    });
  });

  it('falls back to a new rich reply when group edits fail', async () => {
    const testContext = createContext('group');
    testContext.editMessageText.mockRejectedValue(new Error('edit failed'));
    const sink = await TelegramStreamSink.create(testContext.context);

    await sink.finish('Финал');

    expect(testContext.editMessageText).toHaveBeenCalledTimes(2);
    expect(testContext.replyWithRichMessage).not.toHaveBeenCalled();
  });

  it('cancels an unfinished group placeholder', async () => {
    const testContext = createContext('group');
    const sink = await TelegramStreamSink.create(testContext.context);
    await sink.cancel();

    expect(testContext.deleteMessage).toHaveBeenCalledWith(-100, 100);
  });
});

describe('collectStreamedText', () => {
  it('emits accumulated text after tool-call pauses', async () => {
    const updates: string[] = [];
    async function* textStream() {
      yield '';
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
