import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeShutdown } from '../runtime-shutdown';

const mocks = vi.hoisted(() => ({
  beginShutdown: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../runtime-state', () => ({
  runtimeState: { beginShutdown: mocks.beginShutdown },
}));
vi.mock('../logger', () => ({
  logger: { error: mocks.error, info: mocks.info },
}));

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
      stopScheduler: async () => {
        order.push('scheduler');
      },
      disconnectDatabase: async () => {
        order.push('database');
      },
      shutdownTelemetry: async () => {
        order.push('telemetry');
      },
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(order).toEqual([
      'health',
      'transport',
      'jobs',
      'embeddings',
      'scheduler',
      'database',
      'telemetry',
    ]);
    expect(mocks.beginShutdown).toHaveBeenCalledOnce();
  });

  it('continues shutdown when telemetry rejects', async () => {
    const shutdown = createRuntimeShutdown({
      drainMs: 100,
      stopHealthServer: vi.fn(),
      stopTransport: vi.fn().mockResolvedValue(undefined),
      stopJobRunner: vi.fn().mockResolvedValue(undefined),
      stopEmbeddings: vi.fn().mockResolvedValue(undefined),
      stopScheduler: vi.fn().mockResolvedValue(undefined),
      disconnectDatabase: vi.fn().mockResolvedValue(undefined),
      shutdownTelemetry: vi.fn().mockRejectedValue(new Error('flush failed')),
    });

    await shutdown();

    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'telemetry.shutdown_failed' }),
      'Telemetry shutdown failed',
    );
    expect(mocks.info).toHaveBeenCalledWith(
      { event: 'process.shutdown_completed' },
      'Bot shutdown completed',
    );
  });

  it('continues shutdown when telemetry exceeds the drain budget', async () => {
    const shutdown = createRuntimeShutdown({
      drainMs: 5,
      stopHealthServer: vi.fn(),
      stopTransport: vi.fn().mockResolvedValue(undefined),
      stopJobRunner: vi.fn().mockResolvedValue(undefined),
      stopEmbeddings: vi.fn().mockResolvedValue(undefined),
      stopScheduler: vi.fn().mockResolvedValue(undefined),
      disconnectDatabase: vi.fn().mockResolvedValue(undefined),
      shutdownTelemetry: () => new Promise<void>(() => {}),
    });

    await shutdown();

    expect(mocks.error).toHaveBeenCalledWith(
      { event: 'telemetry.shutdown_timeout', timeoutMs: 5 },
      'Telemetry shutdown timed out',
    );
  });
});
