import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('../db', () => ({
  prisma: { message: { findMany } },
}));

import { findMessageActivityInRange } from '../repositories/analytics-repository';

beforeEach(() => vi.clearAllMocks());

describe('findMessageActivityInRange', () => {
  it('counts incoming and answered activity without self-replies or IDs in the result', async () => {
    findMany
      .mockResolvedValueOnce([
        { chatId: 1n, senderId: 10n, chat: { chatType: 'PRIVATE' } },
        { chatId: 2n, senderId: 10n, chat: { chatType: 'GROUP' } },
      ])
      .mockResolvedValueOnce([
        {
          chatId: 2n,
          replyToMessage: {
            senderId: 10n,
            chat: { chatType: 'GROUP' },
          },
        },
        {
          chatId: 2n,
          replyToMessage: {
            senderId: 999n,
            chat: { chatType: 'GROUP' },
          },
        },
        { chatId: 2n, replyToMessage: null },
      ]);

    const result = await findMessageActivityInRange(
      new Date('2026-08-23T00:00:00Z'),
      new Date('2026-08-24T00:00:00Z'),
      999n,
    );

    expect(result).toEqual({
      incomingMessages: 2,
      seenChats: 2,
      seenUsers: 1,
      answeredMessages: 1,
      answeredChats: 1,
      answeredUsers: 1,
      incomingByChatType: { private: 1, group: 1 },
      answeredByChatType: { private: 0, group: 1 },
      incomingMessagesByChatType: { private: 1, group: 1 },
      answeredMessagesByChatType: { private: 0, group: 1 },
    });
  });

  it('returns zeroes for an empty period', async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await expect(
      findMessageActivityInRange(
        new Date('2026-08-23T00:00:00Z'),
        new Date('2026-08-24T00:00:00Z'),
        999n,
      ),
    ).resolves.toEqual({
      incomingMessages: 0,
      seenChats: 0,
      seenUsers: 0,
      answeredMessages: 0,
      answeredChats: 0,
      answeredUsers: 0,
      incomingByChatType: { private: 0, group: 0 },
      answeredByChatType: { private: 0, group: 0 },
      incomingMessagesByChatType: { private: 0, group: 0 },
      answeredMessagesByChatType: { private: 0, group: 0 },
    });
  });
});
