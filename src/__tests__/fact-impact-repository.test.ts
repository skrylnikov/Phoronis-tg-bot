import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRaw = vi.hoisted(() => vi.fn());

vi.mock('../db', () => ({
  prisma: { $queryRaw: queryRaw },
}));

import { recalculateFactImpactScoresRepo } from '../repositories/fact-impact-repository';

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([{ id: 1n }, { id: 2n }]);
});

describe('fact impact recalculation', () => {
  it('updates scores with one set-based query', async () => {
    await expect(recalculateFactImpactScoresRepo()).resolves.toBe(2);

    expect(queryRaw).toHaveBeenCalledOnce();
    const sql = (queryRaw.mock.calls[0][0] as TemplateStringsArray).join(' ');
    expect(sql).toContain('UPDATE "UserFact"');
    expect(sql).toContain('FROM "FactImpact"');
    expect(sql).toContain('GROUP BY impact."factId"');
  });
});
