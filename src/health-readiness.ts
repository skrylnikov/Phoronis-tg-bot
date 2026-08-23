import { checkEmbeddingHealth } from './ai/embedding';
import { healthCheckRepo } from './repositories/embedding-repository';
import { logger } from './logger';

export async function getReadinessResponse(): Promise<Response> {
  try {
    await healthCheckRepo();
    const embeddingsReady = await checkEmbeddingHealth();
    return Response.json({
      status: embeddingsReady ? 'ready' : 'degraded',
      components: {
        database: 'ready',
        embeddings: embeddingsReady ? 'ready' : 'degraded',
      },
    });
  } catch (error) {
    logger.warn(
      { event: 'health.readiness_failed', err: error },
      'Readiness check failed',
    );
    return Response.json({ status: 'not-ready' }, { status: 503 });
  }
}
