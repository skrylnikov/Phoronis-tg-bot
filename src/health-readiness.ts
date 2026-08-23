import { checkEmbeddingHealth } from './ai/embedding';
import { logger } from './logger';
import { healthCheckRepo } from './repositories/embedding-repository';
import { type RuntimeState, runtimeState } from './runtime-state';

export async function getReadinessResponse(
  state: RuntimeState = runtimeState,
): Promise<Response> {
  if (!state.isReady()) {
    return Response.json(
      { status: 'not-ready', components: state.snapshot() },
      { status: 503 },
    );
  }

  try {
    await healthCheckRepo();
    const embeddingsReady = await checkEmbeddingHealth();
    state.setReady('database', true);
    state.setReady('embeddings', embeddingsReady);
    if (!embeddingsReady) {
      return Response.json(
        { status: 'not-ready', components: state.snapshot() },
        { status: 503 },
      );
    }
    return Response.json({ status: 'ready', components: state.snapshot() });
  } catch (error) {
    state.setReady('database', false);
    logger.warn(
      { event: 'health.readiness_failed', err: error },
      'Readiness check failed',
    );
    return Response.json(
      { status: 'not-ready', components: state.snapshot() },
      { status: 503 },
    );
  }
}
