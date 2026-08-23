import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $queryRaw: vi.fn(),
    telegramUpdate: { updateMany: vi.fn() },
  },
}));

vi.mock('../db', () => ({ prisma }));

import {
  claimNextTelegramUpdateRepo,
  heartbeatTelegramUpdateRepo,
} from '../repositories/telegram-update-repository';

describe('Telegram update repository', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks older updates across lanes inside one partition', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await claimNextTelegramUpdateRepo('URGENT', 'worker-1', 10_000);

    const query = prisma.$queryRaw.mock.calls[0]?.[0] as { strings: string[] };
    expect(query.strings.join('')).not.toContain('older."lane"');
    expect(query.strings.join('')).toContain('older."partitionKey"');
  });

  it('renews only the current update lease owner', async () => {
    prisma.telegramUpdate.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(
      heartbeatTelegramUpdateRepo(42n, 'worker-1', 10_000),
    ).resolves.toBe(true);
    expect(prisma.telegramUpdate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { updateId: 42n, status: 'PROCESSING', workerId: 'worker-1' },
      }),
    );
  });
});
