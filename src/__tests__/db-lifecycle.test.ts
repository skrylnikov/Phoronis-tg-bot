import { beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: {
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $queryRaw: vi.fn(),
  },
  PrismaClient: vi.fn(),
  PrismaPg: vi.fn(),
}));

mocks.PrismaClient.mockImplementation(function PrismaClient() {
  return mocks.client;
});
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: mocks.PrismaPg }));
vi.mock('../generated/prisma/client', () => ({
  PrismaClient: mocks.PrismaClient,
}));
vi.mock('../logger', () => ({ logger: { info: vi.fn() } }));

let db: typeof import('../db');

beforeAll(async () => {
  db = await import('../db');
});

describe('database lifecycle', () => {
  it('does not connect while importing the database module', () => {
    expect(mocks.client.$connect).not.toHaveBeenCalled();
    expect(mocks.client.$disconnect).not.toHaveBeenCalled();
  });

  it('exposes explicit connect, health check and disconnect operations', async () => {
    mocks.client.$queryRaw.mockResolvedValueOnce([{ ok: 1 }]);

    await db.connectPrismaRepo();
    await db.checkPrismaRepo();
    await db.disconnectPrismaRepo();

    expect(mocks.client.$connect).toHaveBeenCalledOnce();
    expect(mocks.client.$queryRaw).toHaveBeenCalledOnce();
    expect(mocks.client.$disconnect).toHaveBeenCalledOnce();
  });
});
