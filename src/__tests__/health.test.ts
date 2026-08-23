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
import { RuntimeState } from '../runtime-state';

describe('readiness', () => {
  beforeEach(() => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    checkEmbeddingHealth.mockReset();
  });

  function readyState(): RuntimeState {
    const state = new RuntimeState();
    state.setReady('database', true);
    state.setReady('embeddings', true);
    state.setReady('transport', true);
    state.setReady('updateWorkers', true);
    state.setReady('jobWorker', true);
    return state;
  }

  it('reports unavailable TEI as not ready', async () => {
    checkEmbeddingHealth.mockResolvedValue(false);

    const response = await getReadinessResponse(readyState());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'not-ready',
      components: {
        database: 'ready',
        embeddings: 'not-ready',
        transport: 'ready',
        updateWorkers: 'ready',
        jobWorker: 'ready',
      },
    });
  });

  it('is unready when PostgreSQL is unavailable', async () => {
    queryRaw.mockRejectedValue(new Error('database unavailable'));

    const response = await getReadinessResponse(readyState());

    expect(response.status).toBe(503);
  });

  it('is not ready before required runtime components start', async () => {
    const response = await getReadinessResponse(new RuntimeState());

    expect(response.status).toBe(503);
  });
});
