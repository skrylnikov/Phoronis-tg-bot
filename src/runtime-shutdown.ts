import { logger } from './logger';
import { runtimeState } from './runtime-state';

export interface RuntimeShutdownDependencies {
  drainMs: number;
  stopHealthServer: () => void;
  stopTransport: () => Promise<void>;
  stopJobRunner: () => Promise<void>;
  stopEmbeddings: () => Promise<void>;
  stopScheduler: () => Promise<void>;
  disconnectDatabase: () => Promise<void>;
  shutdownTelemetry: () => Promise<void>;
}

function waitForDrain(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([operation.then(() => true), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createRuntimeShutdown(
  dependencies: RuntimeShutdownDependencies,
): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  return () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info(
        { event: 'process.shutdown_started' },
        'Shutting down the bot',
      );
      runtimeState.beginShutdown();
      dependencies.stopHealthServer();
      await dependencies.stopTransport();
      await waitForDrain(dependencies.stopJobRunner(), dependencies.drainMs);
      await dependencies.stopEmbeddings();
      await dependencies.stopScheduler();
      await dependencies.disconnectDatabase();
      try {
        const completed = await waitForDrain(
          dependencies.shutdownTelemetry(),
          dependencies.drainMs,
        );
        if (!completed) {
          logger.error(
            {
              event: 'telemetry.shutdown_timeout',
              timeoutMs: dependencies.drainMs,
            },
            'Telemetry shutdown timed out',
          );
        }
      } catch (err) {
        logger.error(
          { event: 'telemetry.shutdown_failed', err },
          'Telemetry shutdown failed',
        );
      }
      logger.info(
        { event: 'process.shutdown_completed' },
        'Bot shutdown completed',
      );
    })();
    return shutdownPromise;
  };
}
