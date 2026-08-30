import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chatGeneration: vi.fn(),
  appendAiThreadAssistantEvent: vi.fn(),
  buildAiThreadContext: vi.fn(),
  extractMentionedUserIds: vi.fn(),
  findFirstMessageRepo: vi.fn(),
  findManyMessagesRepo: vi.fn(),
  findManyUsersRepo: vi.fn(),
  findMessageWithSelectRepo: vi.fn(),
  getRecentMemoriesForUsers: vi.fn(),
  getTopUserFacts: vi.fn(),
  getRecentPublicChatContext: vi.fn(),
  loggerError: vi.fn(),
  reserveQuota: vi.fn(),
  saveChat: vi.fn(),
  saveMessage: vi.fn(),
  saveUser: vi.fn(),
  searchContext: vi.fn(),
  streamSinkCreate: vi.fn(),
  recordAiAttempt: vi.fn(),
  recordAiFailure: vi.fn(),
  recordAiSuccess: vi.fn(),
  releaseQuota: vi.fn(),
}));

vi.mock('../domain', () => ({
  createPurchaseSession: vi.fn(),
  releaseQuota: mocks.releaseQuota,
  reserveQuota: mocks.reserveQuota,
  saveChat: mocks.saveChat,
  saveMessage: mocks.saveMessage,
  saveUser: mocks.saveUser,
  shouldSendLimitNotice: vi.fn(),
}));
vi.mock('../domain/entities', () => ({
  extractMentionedUserIds: mocks.extractMentionedUserIds,
}));
vi.mock('../domain/memory', () => ({
  getRecentMemoriesForUsers: mocks.getRecentMemoriesForUsers,
}));
vi.mock('../domain/user/fact-analyzer', () => ({
  getTopUserFacts: mocks.getTopUserFacts,
}));
vi.mock('../config', () => ({
  sessionIdGenerator: vi.fn(() => 'session'),
}));
vi.mock('../repositories/message-repository', () => ({
  findFirstMessageRepo: mocks.findFirstMessageRepo,
  findManyMessagesRepo: mocks.findManyMessagesRepo,
  findMessageWithSelectRepo: mocks.findMessageWithSelectRepo,
}));
vi.mock('../repositories/user-repository', () => ({
  findManyUsersRepo: mocks.findManyUsersRepo,
}));
vi.mock('../ai/ai', () => ({
  chatModel: { modelId: 'google/gemini-3.7-flash' },
  liteChatModel: { modelId: 'deepseek/deepseek-v4-flash' },
}));
vi.mock('../analytics-runtime', () => ({
  recordAiAttempt: mocks.recordAiAttempt,
  recordAiFailure: mocks.recordAiFailure,
  recordAiSuccess: mocks.recordAiSuccess,
}));
vi.mock('../ai/chat-generation', () => ({
  chatGeneration: mocks.chatGeneration,
}));
vi.mock('../ai/embedding', () => ({ searchContext: mocks.searchContext }));
vi.mock('../ai/langfuse', () => ({
  withAiObservation: vi.fn((_name, _options, callback) =>
    callback({ update: vi.fn() }),
  ),
}));
vi.mock('../ai/rich-message', () => ({ richMarkdownInstructions: '' }));
vi.mock('../ai/telegram-stream', () => ({
  TelegramStreamSink: { create: mocks.streamSinkCreate },
}));
vi.mock('../ai/thread-context', async () => ({
  ...(await vi.importActual('../ai/thread-context')),
  appendAiThreadAssistantEvent: mocks.appendAiThreadAssistantEvent,
  buildAiThreadContext: mocks.buildAiThreadContext,
}));
vi.mock('../ai/tools', () => ({
  getRecentPublicChatContext: mocks.getRecentPublicChatContext,
}));
vi.mock('../logger', () => ({
  logger: { error: mocks.loggerError, info: vi.fn() },
}));

import { aiController } from '../ai/controllet';

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveChat.mockResolvedValue(undefined);
  mocks.saveUser.mockResolvedValue(undefined);
  mocks.findFirstMessageRepo.mockResolvedValue(null);
  mocks.reserveQuota.mockResolvedValue({ allowed: true });
  mocks.releaseQuota.mockResolvedValue(undefined);
  mocks.extractMentionedUserIds.mockResolvedValue([]);
  mocks.getRecentMemoriesForUsers.mockResolvedValue(new Map());
  mocks.findManyUsersRepo.mockResolvedValue([]);
  mocks.chatGeneration.mockResolvedValue('Ответ');
  mocks.streamSinkCreate.mockResolvedValue({
    cancel: vi.fn(),
    finish: vi.fn().mockResolvedValue({
      message_id: 900,
      date: 1,
      from: { id: 999 },
    }),
    update: vi.fn(),
  });
  mocks.buildAiThreadContext.mockResolvedValue({
    instructions: 'rules',
    messages: [],
    telemetry: {},
  });
});

describe('AI response idempotency', () => {
  it('releases quota and does not record success when final delivery is rejected', async () => {
    const reservation = { allowed: true };
    const deliveryError = new Error('Telegram rejected final payload');
    mocks.reserveQuota.mockResolvedValue(reservation);
    mocks.streamSinkCreate.mockResolvedValue({
      cancel: vi.fn(),
      finish: vi.fn().mockRejectedValue(deliveryError),
      update: vi.fn(),
    });

    await expect(
      aiController({
        chat: { id: 100, type: 'private' },
        chatId: 100,
        from: { id: 42, is_bot: false, first_name: 'User' },
        me: { id: 999, is_bot: true, first_name: 'Bot' },
        msg: { message_id: 41, text: 'hello' },
        replyWithChatAction: vi.fn().mockResolvedValue(true),
      } as never),
    ).rejects.toThrow(deliveryError);

    expect(mocks.releaseQuota).toHaveBeenCalledWith(reservation);
    expect(mocks.recordAiFailure).toHaveBeenCalledOnce();
    expect(mocks.recordAiSuccess).not.toHaveBeenCalled();
    expect(mocks.saveMessage).not.toHaveBeenCalled();
  });

  it('limits ephemeral generation before delivery', async () => {
    await aiController(
      {
        chat: { id: -100, type: 'supergroup' },
        chatId: -100,
        from: { id: 42, is_bot: false, first_name: 'User' },
        me: { id: 999, is_bot: true, first_name: 'Bot' },
        msg: { message_id: 41, text: 'hello' },
      } as never,
      undefined,
      undefined,
      undefined,
      { ephemeralReceiverUserId: 42, persistResponse: false },
    );

    expect(mocks.chatGeneration.mock.calls[0]?.[4]).toEqual(
      expect.objectContaining({ maxOutputTokens: 4096 }),
    );
  });

  it('skips generation when the response was already persisted', async () => {
    mocks.saveChat.mockResolvedValue(undefined);
    mocks.saveUser.mockResolvedValue(undefined);
    mocks.findFirstMessageRepo.mockResolvedValue({ id: 900n });

    await aiController({
      chat: { id: 100, type: 'private' },
      chatId: 100,
      from: { id: 42, is_bot: false, first_name: 'User' },
      me: { id: 999, is_bot: true, first_name: 'Bot' },
      msg: { message_id: 41, text: 'hello' },
    } as never);

    expect(mocks.findFirstMessageRepo).toHaveBeenCalledWith({
      chatId: 100n,
      replyToMessageId: 41n,
      senderId: 999n,
      messageType: 'TEXT',
    });
    expect(mocks.reserveQuota).not.toHaveBeenCalled();
  });

  it('continues generation when Telegram rejects the initial typing action', async () => {
    mocks.saveChat.mockResolvedValue(undefined);
    mocks.saveUser.mockResolvedValue(undefined);
    mocks.findFirstMessageRepo.mockResolvedValue(null);
    mocks.reserveQuota.mockResolvedValue({ allowed: true });
    mocks.extractMentionedUserIds.mockResolvedValue([]);
    mocks.getRecentMemoriesForUsers.mockResolvedValue(new Map());
    mocks.findManyUsersRepo.mockResolvedValue([]);
    mocks.chatGeneration.mockResolvedValue('Ответ');
    const streamSink = {
      cancel: vi.fn(),
      finish: vi.fn().mockResolvedValue({
        message_id: 900,
        date: 1,
        from: { id: 999 },
      }),
      update: vi.fn(),
    };
    mocks.streamSinkCreate.mockResolvedValue(streamSink);
    const typingError = new Error('Telegram unavailable');
    const replyWithChatAction = vi.fn().mockRejectedValue(typingError);

    await aiController({
      chat: { id: 100, type: 'private' },
      chatId: 100,
      from: { id: 42, is_bot: false, first_name: 'User' },
      me: { id: 999, is_bot: true, first_name: 'Bot' },
      msg: { message_id: 41, text: 'hello' },
      replyWithChatAction,
    } as never);

    expect(replyWithChatAction).toHaveBeenCalledWith('typing');
    expect(mocks.chatGeneration).toHaveBeenCalled();
    expect(streamSink.finish).toHaveBeenCalledWith('Ответ');
    expect(mocks.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'google/gemini-3.7-flash' }),
    );
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'telegram.typing_failed',
        err: typingError,
      }),
      'Failed to update Telegram typing status',
    );
  });

  it('does not create a second heartbeat when one is already active', async () => {
    vi.useFakeTimers();
    mocks.saveChat.mockResolvedValue(undefined);
    mocks.saveUser.mockResolvedValue(undefined);
    mocks.findFirstMessageRepo.mockResolvedValue(null);
    mocks.reserveQuota.mockResolvedValue({ allowed: true });
    mocks.extractMentionedUserIds.mockResolvedValue([]);
    mocks.getRecentMemoriesForUsers.mockResolvedValue(new Map());
    mocks.findManyUsersRepo.mockResolvedValue([]);
    mocks.chatGeneration.mockResolvedValue('Ответ');
    mocks.streamSinkCreate.mockResolvedValue({
      cancel: vi.fn(),
      finish: vi.fn().mockResolvedValue({
        message_id: 900,
        date: 1,
        from: { id: 999 },
      }),
      update: vi.fn(),
    });
    const replyWithChatAction = vi.fn().mockResolvedValue(true);
    const typingStatus = { stop: vi.fn() };

    await aiController(
      {
        chat: { id: 100, type: 'private' },
        chatId: 100,
        from: { id: 42, is_bot: false, first_name: 'User' },
        me: { id: 999, is_bot: true, first_name: 'Bot' },
        msg: { message_id: 41, text: 'hello' },
        replyWithChatAction,
      } as never,
      undefined,
      undefined,
      undefined,
      { typingStatus },
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(replyWithChatAction).not.toHaveBeenCalled();
    expect(typingStatus.stop).not.toHaveBeenCalled();
  });
});

describe('private AI context', () => {
  it.each(['text', 'photo'])(
    'uses the full context pipeline for %s without making tools read-only',
    async (kind) => {
      const text = kind === 'photo' ? 'Что на фото?' : 'Приватный запрос';
      mocks.searchContext.mockResolvedValue({
        userContext: ['публичный retrieval'],
        chatContext: null,
      });
      mocks.extractMentionedUserIds.mockResolvedValue([84]);
      mocks.findManyUsersRepo.mockResolvedValue([
        {
          id: 42n,
          firstName: 'User',
          lastName: null,
          userName: 'user',
        },
        {
          id: 84n,
          firstName: 'Mentioned',
          lastName: null,
          userName: 'mentioned',
        },
      ]);
      mocks.getRecentMemoriesForUsers.mockResolvedValue(
        new Map([[42, ['сохранённая память']]]),
      );
      mocks.getTopUserFacts.mockResolvedValue([]);
      mocks.getRecentPublicChatContext.mockResolvedValue({
        messages: [{ id: '1', content: 'публичная история' }],
        truncated: false,
      });
      mocks.buildAiThreadContext.mockImplementationOnce(async (input) => ({
        instructions: 'rules',
        messages: [input.currentUserMessage],
        telemetry: {},
      }));
      await aiController(
        {
          chat: { id: 100, type: 'private' },
          chatId: 100,
          from: { id: 42, is_bot: false, first_name: 'User' },
          me: { id: 999, is_bot: true, first_name: 'Bot' },
          msg: { message_id: 41, text },
          replyWithChatAction: vi.fn().mockResolvedValue(true),
        } as never,
        kind === 'photo' ? 'Описание фото' : undefined,
        undefined,
        undefined,
        {
          privateMode: true,
          resolveContext: true,
          includeRecentChatContext: true,
        },
      );

      const [messages, , , , options] =
        mocks.chatGeneration.mock.calls[0] ?? [];
      expect(JSON.stringify(messages)).toContain(text);
      if (kind === 'photo')
        expect(JSON.stringify(messages)).toContain('Описание фото');
      expect(options).toMatchObject({
        readOnlyTools: undefined,
        allowChatHistory: true,
      });
      expect(mocks.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ private: true }),
      );
      expect(mocks.searchContext).toHaveBeenCalled();
      expect(mocks.findMessageWithSelectRepo).toHaveBeenCalled();
      expect(mocks.extractMentionedUserIds).toHaveBeenCalled();
      expect(mocks.findManyUsersRepo).toHaveBeenCalled();
      expect(mocks.getRecentMemoriesForUsers).toHaveBeenCalledWith(
        [42],
        100,
        10,
      );
      expect(mocks.getTopUserFacts).toHaveBeenCalled();
      expect(mocks.getRecentPublicChatContext).toHaveBeenCalled();
      expect(mocks.buildAiThreadContext).toHaveBeenCalledWith(
        expect.objectContaining({
          privateMode: true,
          retrievalContext: expect.objectContaining({
            userContext: ['публичный retrieval'],
          }),
        }),
      );
      expect(mocks.appendAiThreadAssistantEvent).toHaveBeenCalledWith(
        'session',
        '41',
        'Ответ',
        { chatId: 100n, messageId: 900n },
      );
    },
  );
});

describe('AI user data scope', () => {
  it('keeps mentioned-user memory and facts from other chats out of context', async () => {
    mocks.extractMentionedUserIds.mockResolvedValue([84]);
    mocks.findManyUsersRepo.mockResolvedValue([
      {
        id: 42n,
        firstName: 'Current',
        lastName: null,
        userName: 'current',
      },
      {
        id: 84n,
        firstName: 'Mentioned',
        lastName: null,
        userName: 'mentioned',
      },
    ]);
    mocks.getRecentMemoriesForUsers.mockResolvedValue(
      new Map([
        [42, ['личная память', 'общая память чата']],
        [84, ['чужая личная память']],
      ]),
    );
    mocks.getTopUserFacts.mockImplementation(
      async (userId: bigint, options: { sourceChatId?: bigint }) =>
        userId === 42n
          ? [{ content: 'свой факт', type: 'FACT', weight: 1, confidence: 1 }]
          : options.sourceChatId === 100n
            ? [
                {
                  content: 'публичный факт этого чата',
                  type: 'FACT',
                  weight: 1,
                  confidence: 1,
                },
              ]
            : [
                {
                  content: 'факт из другого чата',
                  type: 'FACT',
                  weight: 1,
                  confidence: 1,
                },
              ],
    );

    await aiController({
      chat: { id: 100, type: 'supergroup' },
      chatId: 100,
      from: { id: 42, is_bot: false, first_name: 'Current' },
      me: { id: 999, is_bot: true, first_name: 'Bot' },
      msg: { message_id: 41, text: 'Что известно про @mentioned?' },
      replyWithChatAction: vi.fn().mockResolvedValue(true),
    } as never);

    expect(mocks.getRecentMemoriesForUsers).toHaveBeenCalledWith([42], 100, 10);
    expect(mocks.getTopUserFacts).toHaveBeenCalledWith(42n, {});
    expect(mocks.getTopUserFacts).toHaveBeenCalledWith(84n, {
      sourceChatId: 100n,
    });
    const context = mocks.buildAiThreadContext.mock.calls[0]?.[0].userContext;
    expect(JSON.stringify(context)).toContain('свой факт');
    expect(JSON.stringify(context)).toContain('публичный факт этого чата');
    expect(JSON.stringify(context)).toContain('личная память');
    expect(JSON.stringify(context)).not.toContain('факт из другого чата');
    expect(JSON.stringify(context)).not.toContain('чужая личная память');
  });
});
