import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryRaw, checkEmbeddingHealth } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  checkEmbeddingHealth: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: { $queryRaw: queryRaw },
}));

vi.mock('../ai/embedding', () => ({
  checkEmbeddingHealth,
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { getReadinessResponse } from '../health-readiness';

describe('readiness', () => {
  beforeEach(() => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    checkEmbeddingHealth.mockReset();
  });

  it('reports unavailable TEI as degraded without becoming unready', async () => {
    checkEmbeddingHealth.mockResolvedValue(false);

    const response = await getReadinessResponse();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'degraded',
      components: { database: 'ready', embeddings: 'degraded' },
    });
  });

  it('is unready when PostgreSQL is unavailable', async () => {
    queryRaw.mockRejectedValue(new Error('database unavailable'));

    const response = await getReadinessResponse();

    expect(response.status).toBe(503);
  });
});
