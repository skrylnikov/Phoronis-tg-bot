import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  prismaMessageFindUnique,
  prismaMessageUpsert,
  handleError,
  lruCacheGet,
  lruCacheHas,
  lruCacheSet,
} = vi.hoisted(() => ({
  prismaMessageFindUnique: vi.fn(),
  prismaMessageUpsert: vi.fn(),
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
      findUnique: prismaMessageFindUnique,
      upsert: prismaMessageUpsert,
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
    prismaMessageUpsert.mockResolvedValueOnce({});

    await saveMessage({
      id: 101n,
      chatId: -100n,
      senderId: 456n,
      sentAt: new Date(),
      replyToMessageId: 99n,
      text: 'Reply to missing message',
    });

    expect(prismaMessageFindUnique).toHaveBeenCalledWith({
      where: {
        chatId_id: {
          chatId: -100n,
          id: 99n,
        },
      },
      select: {
        id: true,
      },
    });

    const upsertCall = prismaMessageUpsert.mock.calls[0][0];
    expect(upsertCall.create.replyToMessageId).toBe(null);
    expect(upsertCall.update.replyToMessageId).toBe(null);
  });

  it('preserves replyToMessageId when parent exists', async () => {
    prismaMessageFindUnique.mockResolvedValueOnce({ id: 99n });
    prismaMessageUpsert.mockResolvedValueOnce({});

    await saveMessage({
      id: 101n,
      chatId: -100n,
      senderId: 456n,
      sentAt: new Date(),
      replyToMessageId: 99n,
      text: 'Reply to existing message',
    });

    const upsertCall = prismaMessageUpsert.mock.calls[0][0];
    expect(upsertCall.create.replyToMessageId).toBe(99n);
    expect(upsertCall.update.replyToMessageId).toBe(99n);
  });

  it('handles undefined replyToMessageId', async () => {
    prismaMessageUpsert.mockResolvedValueOnce({});

    await saveMessage({
      id: 101n,
      chatId: -100n,
      senderId: 456n,
      sentAt: new Date(),
      text: 'No reply',
    });

    expect(prismaMessageFindUnique).not.toHaveBeenCalled();
    const upsertCall = prismaMessageUpsert.mock.calls[0][0];
    expect(upsertCall.create.replyToMessageId).toBe(null);
    expect(upsertCall.update.replyToMessageId).toBe(null);
  });
});
