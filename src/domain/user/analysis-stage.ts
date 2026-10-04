import { AsyncLocalStorage } from 'node:async_hooks';
import { decisionModelId, utilityModelId } from '../../ai/model-ids';
import { logger } from '../../logger';
import {
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
  withUpdateAbortSignal,
} from '../../update-signal';

const context = new AsyncLocalStorage<{
  jobId?: string;
  attempt?: number;
  runId: string;
}>();
export function withAnalysisAttempt<T>(
  metadata: { jobId?: string; attempt?: number; runId: string },
  callback: () => T,
): T {
  return context.run(metadata, callback);
}
export function currentAnalysisRunId() {
  return context.getStore()?.runId ?? crypto.randomUUID();
}
export function analysisErrorCategory(error: unknown) {
  if (error instanceof AnalysisStageError) return error.category;
  if (error instanceof Error && error.cause)
    return analysisErrorCategory(error.cause);
  if (
    error instanceof Error &&
    /^Invalid (?:analysis window|user analysis job)/u.test(error.message)
  )
    return 'invalid_input';
  const name = error instanceof Error ? error.name : '';
  if (
    error &&
    typeof error === 'object' &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  )
    return `http_${error.statusCode}`;
  return name === 'TimeoutError' ||
    (error instanceof Error && /timed? ?out|timeout/i.test(error.message))
    ? 'timeout'
    : name === 'AbortError'
      ? 'cancelled'
      : 'operation_failed';
}
export class AnalysisStageError extends Error {
  readonly retryable: boolean;
  constructor(
    public stage: string,
    public category: string,
  ) {
    super(`analysis:${stage}:${category}`);
    this.name = 'AnalysisStageError';
    this.retryable =
      category !== 'invalid_input' &&
      !/^http_(?:400|401|403|404|405|422)$/u.test(category);
  }
}
export async function analysisStage<T>(
  stage: string,
  callback: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  throwIfUpdateAborted();
  const parent = currentUpdateAbortSignal();
  const signal = AbortSignal.any([
    ...(parent ? [parent] : []),
    AbortSignal.timeout(timeoutMs),
  ]);
  const startedAt = performance.now();
  try {
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let result: T;
    try {
      result = await Promise.race([
        withUpdateAbortSignal(signal, callback),
        cancelled,
      ]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    signal.throwIfAborted();
    logger.info(
      {
        event: 'user_analysis.stage_completed',
        ...context.getStore(),
        stage,
        model:
          stage === 'extraction'
            ? utilityModelId
            : stage === 'verification' || stage === 'fact_relation'
              ? decisionModelId
              : undefined,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'User analysis stage completed',
    );
    return result;
  } catch (error) {
    const category = analysisErrorCategory(
      signal.aborted ? signal.reason : error,
    );
    logger.warn(
      {
        event: 'user_analysis.stage_failed',
        ...context.getStore(),
        stage,
        model:
          stage === 'extraction'
            ? utilityModelId
            : stage === 'verification' || stage === 'fact_relation'
              ? decisionModelId
              : undefined,
        category,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'User analysis stage failed',
    );
    throw error instanceof AnalysisStageError
      ? error
      : new AnalysisStageError(stage, category);
  }
}
