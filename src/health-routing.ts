import { getReadinessResponse } from './health-readiness';
import { logger } from './logger';
import { runtimeState } from './runtime-state';
import type { BunWebhookHandler } from './transport';

export interface HealthServerOptions {
  webhookPath?: string;
  webhookHandler?: BunWebhookHandler;
}

export function createHealthFetch({
  webhookPath,
  webhookHandler,
}: HealthServerOptions = {}) {
  return async (request: Request) => {
    const path = new URL(request.url).pathname;

    if (path === '/healthz') {
      return Response.json({ status: 'ok' });
    }

    if (path === '/readyz') {
      return getReadinessResponse();
    }

    if (webhookPath && path === webhookPath) {
      if (request.method !== 'POST' || !webhookHandler) {
        return new Response('Method not allowed', { status: 405 });
      }

      const startedAt = Date.now();
      try {
        if (runtimeState.isShuttingDown()) {
          return new Response('Service unavailable', { status: 503 });
        }
        return await webhookHandler({
          headers: request.headers,
          json: () => request.json(),
        });
      } catch (error) {
        logger.error(
          {
            event: 'transport.webhook_failed',
            err: error,
            durationMs: Date.now() - startedAt,
          },
          'Webhook update failed',
        );
        return new Response('Internal Server Error', { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  };
}
