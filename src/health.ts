import { serve } from 'bun';
import { prisma } from './db';
import { logger } from './logger';
import { qdrantClient } from './qdrant';

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
        try {
          await Promise.all([
            prisma.$queryRaw`SELECT 1`,
            qdrantClient.getCollections(),
          ]);
          return Response.json({ status: 'ready' });
        } catch (error) {
          logger.warn({ error }, 'Readiness check failed');
          return Response.json({ status: 'not-ready' }, { status: 503 });
        }
      }

      return new Response('Not found', { status: 404 });
    },
  });

  logger.info({ port }, 'Health server started');
  return server;
}
