import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirstMessageRepo: vi.fn(),
  findManyMessagesRepo: vi.fn(),
  prisma: {
    $queryRaw: vi.fn(),
    message: {
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../db', () => ({ prisma: mocks.prisma }));
vi.mock('../ai/embedding/client', () => ({ embedQuery: vi.fn() }));
vi.mock('../ai/embedding/store', () => ({
  searchChatMessages: vi.fn(),
  searchChatMessagesLexical: vi.fn(),
}));
vi.mock('../ai/history-intent', () => ({
  isGenericHistorySearchRequest: vi.fn(() => false),
}));
vi.mock('../repositories/message-repository', async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import('../repositories/message-repository');
  return {
    ...actual,
    countMessagesRepo: vi.fn(),
    findFirstMessageRepo: mocks.findFirstMessageRepo,
    findManyMessagesRepo: mocks.findManyMessagesRepo,
  };
});

import { getRecentPublicChatContext } from '../ai/tools/chat-history';
import {
  findMessagesForEmbeddingBackfillRepo,
  searchChatMessagesRepo,
} from '../repositories/embedding-repository';
import { deleteOldPrivateMessagesRepo } from '../repositories/message-repository';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findManyMessagesRepo.mockResolvedValue([]);
  mocks.prisma.message.deleteMany.mockResolvedValue({ count: 0 });
  mocks.prisma.message.findMany.mockResolvedValue([]);
  mocks.prisma.$queryRaw.mockResolvedValue([]);
});

describe('private message retention boundaries', () => {
  it('keeps recent history restricted to public messages', async () => {
    await getRecentPublicChatContext(100, 50);

    expect(mocks.findManyMessagesRepo).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 100n, private: false }),
      expect.any(Object),
    );
  });

  it('keeps private messages out of embedding backfill', async () => {
    await findMessagesForEmbeddingBackfillRepo(2, 10);

    expect(mocks.prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            expect.any(Object),
            { OR: [{ private: false }, { private: null }] },
          ],
        },
      }),
    );
  });

  it('keeps private messages out of semantic retrieval', async () => {
    await searchChatMessagesRepo({
      chatId: 100n,
      embedding: [0.1],
      threshold: 0.8,
      limit: 10,
      version: 2,
    });

    const query = mocks.prisma.$queryRaw.mock.calls[0]?.[0] as {
      sql?: string;
    };
    expect(query.sql).toContain('m."private" = FALSE');
  });

  it('deletes only private messages older than seven days without migration', async () => {
    await deleteOldPrivateMessagesRepo();

    expect(mocks.prisma.message.deleteMany).toHaveBeenCalledWith({
      where: {
        private: true,
        sentAt: { lt: expect.any(Date) },
      },
    });
    expect(mocks.prisma.message.findMany).not.toHaveBeenCalled();
  });
});
