import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  prismaMessageCreate,
  prismaMessageFindUnique,
  handleError,
  lruCacheGet,
  lruCacheHas,
  lruCacheSet,
} = vi.hoisted(() => ({
  prismaMessageCreate: vi.fn(),
  prismaMessageFindUnique: vi.fn(),
  handleError: vi.fn(),
  lruCacheGet: vi.fn(),
  lruCacheHas: vi.fn(),
  lruCacheSet: vi.fn(),
}));

vi.mock('lru-cache', () => ({
  LRUCache: class {
    get = lruCacheGet;
    has = lruCacheHas;
    set = lruCacheSet;
  },
}));

vi.mock('../db', () => ({
  prisma: {
    message: {
      create: prismaMessageCreate,
      findUnique: prismaMessageFindUnique,
    },
  },
}));

vi.mock('../utils/error-handler', () => ({
  handleError,
}));

import { saveMessage } from '../repositories/message-repository';

describe('saveMessage parent check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lruCacheHas.mockReturnValue(false);
    lruCacheSet.mockReturnValue(undefined);
  });

  it('sets replyToMessageId to null when parent does not exist', async () => {
    prismaMessageFindUnique.mockResolvedValueOnce(null);
    prismaMessageCreate.mockResolvedValueOnce({});

    const result = await saveMessage({
      id: 123n,
      chatId: 456n,
      senderId: 789n,
      sentAt: new Date('2026-08-23T10:00:00Z'),
      text: 'Test reply',
      replyToMessageId: 99n,
    });

    expect(result.created).toBe(true);
    expect(prismaMessageFindUnique).toHaveBeenCalledWith({
      where: { chatId_id: { chatId: 456n, id: 99n } },
      select: { id: true },
    });
    const createCall = prismaMessageCreate.mock.calls[0][0];
    expect(createCall.data.replyToMessageId).toBe(null);
  });

  it('keeps replyToMessageId when parent exists', async () => {
    prismaMessageFindUnique.mockResolvedValueOnce({ id: 99n });
    prismaMessageCreate.mockResolvedValueOnce({});

    const result = await saveMessage({
      id: 123n,
      chatId: 456n,
      senderId: 789n,
      sentAt: new Date('2026-08-23T10:00:00Z'),
      text: 'Test reply',
      replyToMessageId: 99n,
    });

    expect(result.created).toBe(true);
    const createCall = prismaMessageCreate.mock.calls[0][0];
    expect(createCall.data.replyToMessageId).toBe(99n);
  });

  it('does not check parent when no replyToMessageId', async () => {
    prismaMessageCreate.mockResolvedValueOnce({});

    const result = await saveMessage({
      id: 123n,
      chatId: 456n,
      senderId: 789n,
      sentAt: new Date('2026-08-23T10:00:00Z'),
      text: 'Test message',
    });

    expect(result.created).toBe(true);
    expect(prismaMessageFindUnique).not.toHaveBeenCalled();
    const createCall = prismaMessageCreate.mock.calls[0][0];
    expect(createCall.data.replyToMessageId).toBe(null);
  });

  it.each([
    ['primary', 'google/gemini-3.7-flash'],
    ['fallback', 'deepseek/deepseek-v4-flash'],
  ])('persists the %s model ID for an AI response', async (_tier, modelId) => {
    prismaMessageCreate.mockResolvedValueOnce({});

    await saveMessage({
      id: 123n,
      chatId: 456n,
      senderId: 789n,
      sentAt: new Date('2026-08-23T10:00:00Z'),
      text: 'AI response',
      modelId,
    });

    expect(prismaMessageCreate.mock.calls[0][0].data.modelId).toBe(modelId);
  });

  it('persists null for an old or non-AI message', async () => {
    prismaMessageCreate.mockResolvedValueOnce({});

    await saveMessage({
      id: 123n,
      chatId: 456n,
      senderId: 789n,
      sentAt: new Date('2026-08-23T10:00:00Z'),
      text: 'User message',
    });

    expect(prismaMessageCreate.mock.calls[0][0].data.modelId).toBe(null);
  });
});

describe('saveMessage idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lruCacheHas.mockReturnValue(false);
    lruCacheSet.mockReturnValue(undefined);
  });

  it('returns created: true on first save', async () => {
    prismaMessageCreate.mockResolvedValueOnce({});

    const result = await saveMessage({
      id: 123n,
      chatId: 456n,
      senderId: 789n,
      sentAt: new Date('2026-08-23T10:00:00Z'),
      text: 'First save',
    });

    expect(result.created).toBe(true);
    expect(prismaMessageCreate).toHaveBeenCalledTimes(1);
    expect(lruCacheSet).toHaveBeenCalledWith('456:123', true);
  });

  it('returns created: false on duplicate (P2002)', async () => {
    prismaMessageCreate.mockRejectedValueOnce({ code: 'P2002' });

    const result = await saveMessage({
      id: 123n,
      chatId: 456n,
      senderId: 789n,
      sentAt: new Date('2026-08-23T10:00:00Z'),
      text: 'Duplicate save',
    });

    expect(result.created).toBe(false);
    expect(lruCacheSet).toHaveBeenCalledWith('456:123', true);
    expect(handleError).not.toHaveBeenCalled();
  });

  it('returns created: false if already in cache', async () => {
    lruCacheHas.mockReturnValue(true);

    const result = await saveMessage({
      id: 123n,
      chatId: 456n,
      senderId: 789n,
      sentAt: new Date('2026-08-23T10:00:00Z'),
      text: 'Cached message',
    });

    expect(result.created).toBe(false);
    expect(prismaMessageCreate).not.toHaveBeenCalled();
  });

  it('rethrows non-P2002 errors', async () => {
    const dbError = new Error('DB connection failed');
    prismaMessageCreate.mockRejectedValueOnce(dbError);

    await expect(
      saveMessage({
        id: 123n,
        chatId: 456n,
        senderId: 789n,
        sentAt: new Date('2026-08-23T10:00:00Z'),
        text: 'Error case',
      }),
    ).rejects.toThrow('DB connection failed');

    expect(handleError).toHaveBeenCalledWith(
      dbError,
      'Error saving message 123',
    );
  });
});
