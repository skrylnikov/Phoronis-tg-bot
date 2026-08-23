import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirstMessageRepo: vi.fn(),
  reserveQuota: vi.fn(),
  saveChat: vi.fn(),
  saveMessage: vi.fn(),
  saveUser: vi.fn(),
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
vi.mock('../domain/entities', () => ({ extractMentionedUserIds: vi.fn() }));
vi.mock('../domain/memory', () => ({ getRecentMemoriesForUsers: vi.fn() }));
vi.mock('../domain/user/fact-analyzer', () => ({
  getTopUserFacts: vi.fn(),
}));
vi.mock('../config', () => ({
  sessionIdGenerator: vi.fn(() => 'session'),
}));
vi.mock('../repositories/message-repository', () => ({
  findFirstMessageRepo: mocks.findFirstMessageRepo,
  findManyMessagesRepo: vi.fn(),
  findMessageWithSelectRepo: vi.fn(),
}));
vi.mock('../repositories/user-repository', () => ({
  findManyUsersRepo: vi.fn(),
}));
vi.mock('../ai/ai', () => ({ chatModel: {}, liteChatModel: {} }));
vi.mock('../ai/chat-generation', () => ({ chatGeneration: vi.fn() }));
vi.mock('../ai/embedding', () => ({ searchContext: vi.fn() }));
vi.mock('../ai/langfuse', () => ({ langfuse: { trace: vi.fn() } }));
vi.mock('../ai/rich-message', () => ({ richMarkdownInstructions: '' }));
vi.mock('../ai/telegram-stream', () => ({
  TelegramStreamSink: { create: vi.fn() },
}));
vi.mock('../ai/tools', () => ({ getRecentPublicChatContext: vi.fn() }));
vi.mock('../logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { aiController } from '../ai/controllet';

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
});
