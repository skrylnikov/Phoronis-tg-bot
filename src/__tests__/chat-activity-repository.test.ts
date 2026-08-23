import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    chat: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    message: {
      groupBy: vi.fn(),
    },
    $executeRaw: vi.fn(),
  },
}));

vi.mock('../db', () => ({ prisma }));

import {
  deactivateChatRepo,
  findActiveGroupChatsRepo,
  reactivateInactiveGroupChatsRepo,
} from '../repositories/chat-repository';
import { countMessageStatsByChatRepo } from '../repositories/message-repository';

beforeEach(() => vi.clearAllMocks());

describe('chat activity repositories', () => {
  it('selects only active group chats', async () => {
    prisma.chat.findMany.mockResolvedValue([]);

    await findActiveGroupChatsRepo();

    expect(prisma.chat.findMany).toHaveBeenCalledWith({
      where: { chatType: 'GROUP', active: true },
      select: { id: true, title: true },
    });
  });

  it('counts replies and voices per chat in batched queries', async () => {
    prisma.message.groupBy
      .mockResolvedValueOnce([{ chatId: 1n, _count: { _all: 4 } }])
      .mockResolvedValueOnce([{ chatId: 2n, _count: { _all: 7 } }]);

    await expect(countMessageStatsByChatRepo([1n, 2n], 999n)).resolves.toEqual(
      new Map([
        [1n, { botReplies: 4, recognizedVoices: 0 }],
        [2n, { botReplies: 0, recognizedVoices: 7 }],
      ]),
    );

    expect(prisma.message.groupBy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        by: ['chatId'],
        where: expect.objectContaining({
          chatId: { in: [1n, 2n] },
          senderId: 999n,
          replyToMessageId: { not: null },
        }),
      }),
    );
    expect(prisma.message.groupBy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        by: ['chatId'],
        where: expect.objectContaining({
          chatId: { in: [1n, 2n] },
          messageType: 'VOICE',
          senderId: { not: 999n },
        }),
      }),
    );
  });

  it('deactivates one chat with an inactivity boundary', async () => {
    const inactiveSince = new Date('2026-08-24T09:00:00.000Z');
    prisma.chat.update.mockResolvedValue({});

    await deactivateChatRepo(1n, inactiveSince);

    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 1n },
      data: { active: false, inactiveSince },
    });
  });

  it('reactivates inactive groups atomically from messages after the boundary', async () => {
    prisma.$executeRaw.mockResolvedValue(2);

    await expect(reactivateInactiveGroupChatsRepo()).resolves.toBe(2);
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
    const query = prisma.$executeRaw.mock.calls[0]?.[0] as {
      strings: string[];
    };
    expect(query.strings.join('')).toContain('chat."chatType" = \'GROUP\'');
    expect(query.strings.join('')).toContain('chat."active" = false');
    expect(query.strings.join('')).toContain(
      'message."sentAt" > chat."inactiveSince"',
    );
  });
});
