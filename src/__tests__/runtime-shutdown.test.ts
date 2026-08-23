import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeShutdown } from '../runtime-shutdown';

const mocks = vi.hoisted(() => ({
  beginShutdown: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../runtime-state', () => ({
  runtimeState: { beginShutdown: mocks.beginShutdown },
}));
vi.mock('../logger', () => ({ logger: { info: mocks.info } }));

beforeEach(() => vi.clearAllMocks());

describe('runtime shutdown', () => {
  it('stops intake, drains workers, then closes dependencies once', async () => {
    const order: string[] = [];
    const shutdown = createRuntimeShutdown({
      drainMs: 100,
      stopHealthServer: () => order.push('health'),
      stopTransport: async () => {
        order.push('transport');
      },
      stopJobRunner: async () => {
        order.push('jobs');
      },
      stopEmbeddings: async () => {
        order.push('embeddings');
      },
      disconnectDatabase: async () => {
        order.push('database');
      },
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(order).toEqual([
      'health',
      'transport',
      'jobs',
      'embeddings',
      'database',
    ]);
    expect(mocks.beginShutdown).toHaveBeenCalledOnce();
  });
});
