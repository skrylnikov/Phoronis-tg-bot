import { serve } from 'bun';
import { createHealthFetch, type HealthServerOptions } from './health-routing';
import { logger } from './logger';

const DEFAULT_HEALTH_PORT = 3000;

export function startHealthServer(options: HealthServerOptions = {}) {
  const port = Number(process.env.HEALTH_PORT || DEFAULT_HEALTH_PORT);

  const server = serve({
    hostname: '0.0.0.0',
    port,
    fetch: createHealthFetch(options),
  });

  logger.info({ port }, 'Health server started');
  return server;
}
