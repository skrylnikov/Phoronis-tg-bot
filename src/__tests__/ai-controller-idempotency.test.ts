import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chatGeneration: vi.fn(),
  extractMentionedUserIds: vi.fn(),
  findFirstMessageRepo: vi.fn(),
  findManyMessagesRepo: vi.fn(),
  findManyUsersRepo: vi.fn(),
  findMessageWithSelectRepo: vi.fn(),
  getRecentMemoriesForUsers: vi.fn(),
  getTopUserFacts: vi.fn(),
  loggerError: vi.fn(),
  reserveQuota: vi.fn(),
  saveChat: vi.fn(),
  saveMessage: vi.fn(),
  saveUser: vi.fn(),
  streamSinkCreate: vi.fn(),
  recordAiAttempt: vi.fn(),
  recordAiFailure: vi.fn(),
  recordAiSuccess: vi.fn(),
}));

vi.mock('../domain', () => ({
  createPurchaseSession: vi.fn(),
  releaseQuota: vi.fn(),
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
vi.mock('../ai/embedding', () => ({ searchContext: vi.fn() }));
vi.mock('../ai/langfuse', () => ({
  withAiObservation: vi.fn((_name, _options, callback) =>
    callback({ update: vi.fn() }),
  ),
}));
vi.mock('../ai/rich-message', () => ({ richMarkdownInstructions: '' }));
vi.mock('../ai/telegram-stream', () => ({
  TelegramStreamSink: { create: mocks.streamSinkCreate },
}));
vi.mock('../ai/tools', () => ({ getRecentPublicChatContext: vi.fn() }));
vi.mock('../logger', () => ({
  logger: { error: mocks.loggerError, info: vi.fn() },
}));

import { aiController } from '../ai/controllet';

afterEach(() => vi.useRealTimers());

describe('AI response idempotency', () => {
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
