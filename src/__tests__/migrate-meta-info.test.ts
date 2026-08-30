import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createUserFactForMigrationRepo: vi.fn(),
  findUserFactsRepo: vi.fn(),
  findUsersForMigrationRepo: vi.fn(),
  updateUserMetaInfoRepo: vi.fn(),
}));

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn(() => ({ stop: vi.fn() })) },
}));
vi.mock('../advisory-lock', () => ({
  SCHEDULER_LOCK_KEYS: { metaInfoMigration: 1 },
  withAdvisoryLock: vi.fn(),
}));
vi.mock('../logger', () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));
vi.mock('../repositories/user-fact-repository', () => ({
  findUserFactsRepo: mocks.findUserFactsRepo,
}));
vi.mock('../repositories/user-meta-repository', () => ({
  createUserFactForMigrationRepo: mocks.createUserFactForMigrationRepo,
  findUsersForMigrationRepo: mocks.findUsersForMigrationRepo,
  updateUserMetaInfoRepo: mocks.updateUserMetaInfoRepo,
}));

import {
  convertMetaInfoToFacts,
  migrateNextBatchOfUsers,
} from '../domain/user/migrate-meta-info';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createUserFactForMigrationRepo.mockResolvedValue({});
  mocks.updateUserMetaInfoRepo.mockResolvedValue({});
});

describe('legacy User.metaInfo migration', () => {
  it('keeps historical categories available as UserFact-compatible records', () => {
    expect(
      convertMetaInfoToFacts({
        interests: [{ value: 'Rust', weight: 3 }],
        communication_style: [{ value: 'Кратко', weight: 2 }],
        notable_traits: [{ value: 'Любопытный', weight: 4 }],
        topics: [{ value: 'Фильмы', weight: 1 }],
        notes: [{ value: 'Старый профиль', weight: 5 }],
      }),
    ).toEqual([
      { content: 'Rust', type: 'INTEREST', weight: 3 },
      { content: 'Кратко', type: 'TEXT_STYLE', weight: 2 },
      { content: 'Любопытный', type: 'FACT', weight: 4 },
      { content: 'Фильмы', type: 'INTEREST', weight: 1 },
      { content: 'Старый профиль', type: 'FACT', weight: 5 },
    ]);
  });

  it('accepts the historical string-only category format', async () => {
    mocks.findUsersForMigrationRepo.mockResolvedValue([
      {
        id: 42n,
        metaInfo: { interests: ['Rust'], notes: ['Старый профиль'] },
      },
    ]);
    mocks.findUserFactsRepo.mockResolvedValue([]);

    await expect(migrateNextBatchOfUsers()).resolves.toBe(1);

    expect(mocks.createUserFactForMigrationRepo).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Rust', type: 'INTEREST', weight: 1 }),
    );
    expect(mocks.createUserFactForMigrationRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Старый профиль',
        type: 'FACT',
        weight: 1,
      }),
    );
  });

  it('clears legacy payload when every target fact already exists after restart', async () => {
    const user = {
      id: 42n,
      metaInfo: {
        interests: [{ value: 'Rust', weight: 3 }],
        topics: [{ value: 'Фильмы', weight: 1 }],
      },
    };
    mocks.findUsersForMigrationRepo
      .mockResolvedValueOnce([user])
      .mockResolvedValueOnce([]);
    mocks.findUserFactsRepo.mockResolvedValue([
      { content: 'Rust' },
      { content: 'Фильмы' },
    ]);

    await expect(migrateNextBatchOfUsers()).resolves.toBe(1);
    await expect(migrateNextBatchOfUsers()).resolves.toBe(0);

    expect(
      mocks.findUsersForMigrationRepo.mock.calls[1]?.[0],
    ).not.toHaveProperty('cursor');
    expect(mocks.createUserFactForMigrationRepo).not.toHaveBeenCalled();
    expect(mocks.updateUserMetaInfoRepo).toHaveBeenCalledOnce();
    expect(mocks.updateUserMetaInfoRepo).toHaveBeenCalledWith(42n, {});
  });

  it('reports an empty legacy payload as processed so the scheduler continues', async () => {
    mocks.findUsersForMigrationRepo.mockResolvedValue([
      { id: 42n, metaInfo: { interests: [] } },
    ]);
    mocks.findUserFactsRepo.mockResolvedValue([]);

    await expect(migrateNextBatchOfUsers()).resolves.toBe(1);

    expect(mocks.createUserFactForMigrationRepo).not.toHaveBeenCalled();
    expect(mocks.updateUserMetaInfoRepo).toHaveBeenCalledWith(42n, {});
  });

  it('creates only missing facts and then clears legacy payload', async () => {
    mocks.findUsersForMigrationRepo.mockResolvedValue([
      {
        id: 42n,
        metaInfo: {
          interests: [{ value: 'Rust', weight: 3 }],
          topics: [{ value: 'Фильмы', weight: 1 }],
        },
      },
    ]);
    mocks.findUserFactsRepo.mockResolvedValue([{ content: 'Rust' }]);

    await expect(migrateNextBatchOfUsers()).resolves.toBe(1);

    expect(mocks.createUserFactForMigrationRepo).toHaveBeenCalledOnce();
    expect(mocks.createUserFactForMigrationRepo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42n, content: 'Фильмы' }),
    );
    expect(mocks.updateUserMetaInfoRepo).toHaveBeenCalledWith(42n, {});
  });
});
