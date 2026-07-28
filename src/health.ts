import { serve } from 'bun';
import { getReadinessResponse } from './health-readiness';
import { logger } from './logger';

const DEFAULT_HEALTH_PORT = 3000;

export function startHealthServer() {
  const port = Number(process.env.HEALTH_PORT || DEFAULT_HEALTH_PORT);

  const server = serve({
    hostname: '0.0.0.0',
    port,
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;

      if (path === '/healthz') {
        return Response.json({ status: 'ok' });
      }

      if (path === '/readyz') {
        return getReadinessResponse();
      }

      return new Response('Not found', { status: 404 });
    },
  });

  logger.info({ port }, 'Health server started');
  return server;
}
