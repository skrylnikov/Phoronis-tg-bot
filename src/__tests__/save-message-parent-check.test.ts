import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMessageFindUnique, prismaMessageUpsert, handleError } = vi.hoisted(
  () => ({
    prismaMessageFindUnique: vi.fn(),
    prismaMessageUpsert: vi.fn(),
    handleError: vi.fn(),
  }),
);

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

    expect(prismaMessageUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          replyToMessageId: null,
        }),
        update: expect.objectContaining({
          replyToMessageId: null,
        }),
      }),
    );
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

    expect(prismaMessageUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          replyToMessageId: 99n,
        }),
        update: expect.objectContaining({
          replyToMessageId: 99n,
        }),
      }),
    );
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
    expect(prismaMessageUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          replyToMessageId: null,
        }),
        update: expect.objectContaining({
          replyToMessageId: null,
        }),
      }),
    );
  });
});
