import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildAnalyticsSnapshot, formatAnalyticsReport } = vi.hoisted(() => ({
  buildAnalyticsSnapshot: vi.fn(),
  formatAnalyticsReport: vi.fn(() => 'Безопасный отчёт'),
}));

vi.mock('../config', () => ({ analyticsChatId: 777 }));
vi.mock('../analytics', () => ({
  buildAnalyticsSnapshot,
  formatAnalyticsReport,
}));

import { analyticsController } from '../controllers/analytics';

function createContext(type: 'private' | 'group', userId: number) {
  return {
    chat: { type },
    from: { id: userId },
    me: { id: 999 },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  buildAnalyticsSnapshot.mockResolvedValue({});
});

describe('analyticsController', () => {
  it('sends a current snapshot only to the owner in a private chat', async () => {
    const context = createContext('private', 777);

    await analyticsController(context as never);

    expect(buildAnalyticsSnapshot).toHaveBeenCalledWith(999, expect.any(Date));
    expect(context.reply).toHaveBeenCalledWith('Безопасный отчёт');
  });

  it.each([
    ['another user', 'private', 123],
    ['the owner in a group', 'group', 777],
  ])('does not answer %s', async (_case, type, userId) => {
    const context = createContext(type as 'private' | 'group', userId);

    await analyticsController(context as never);

    expect(buildAnalyticsSnapshot).not.toHaveBeenCalled();
    expect(context.reply).not.toHaveBeenCalled();
  });
});
