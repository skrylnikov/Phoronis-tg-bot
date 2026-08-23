import { logger } from './logger';
import { runtimeState } from './runtime-state';

export interface RuntimeShutdownDependencies {
  drainMs: number;
  stopHealthServer: () => void;
  stopTransport: () => Promise<void>;
  stopJobRunner: () => Promise<void>;
  stopEmbeddings: () => Promise<void>;
  disconnectDatabase: () => Promise<void>;
}

function waitForDrain(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
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
      await dependencies.disconnectDatabase();
      logger.info(
        { event: 'process.shutdown_completed' },
        'Bot shutdown completed',
      );
    })();
    return shutdownPromise;
  };
}
