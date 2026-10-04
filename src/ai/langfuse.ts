import {
  type LangfuseSpan,
  propagateAttributes,
  startActiveObservation,
} from '@langfuse/tracing';
import { logger } from '../logger';
import { sanitizeTraceData, tracePolicy } from './trace-data';

const safeMetadataKeys = new Set([
  'chatId',
  'messageId',
  'updateId',
  'ttftMs',
  'finishReason',
  'partial',
  'contentExcludedReason',
  'cacheBoundary',
  'chatType',
  'dynamicCharacters',
  'inputCharacters',
  'inputMessageCount',
  'latencyMs',
  'outputCharacters',
  'promptHash',
  'promptVersion',
  'providerCacheRead',
  'providerCacheWrite',
  'stablePrefixCharacters',
  'threadId',
]);

export type AiObservationMetadata = object;

export interface AiObservationOptions {
  privateMode?: boolean;
  sessionId?: string | null;
  userId?: string | null;
  metadata?: AiObservationMetadata;
}

function normalizeValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, 200);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

export function normalizeAiMetadata(
  metadata: AiObservationMetadata | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).flatMap(([key, value]) => {
      if (!safeMetadataKeys.has(key)) return [];
      const normalized = normalizeValue(value);
      return normalized === undefined ? [] : [[key, normalized]];
    }),
  );
}

export async function withAiObservation<T>(
  name: 'chat-generation' | 'guest-generation',
  options: AiObservationOptions,
  callback: (observation: LangfuseSpan | undefined) => Promise<T>,
): Promise<T> {
  const attributes = {
    ...(options.sessionId
      ? { sessionId: options.sessionId.slice(0, 200) }
      : {}),
    ...(options.userId ? { userId: options.userId.slice(0, 200) } : {}),
    metadata: normalizeAiMetadata(options.metadata),
  };

  return tracePolicy.run(
    { privateMode: options.privateMode ?? false },
    async () => {
      let operation: Promise<T> | undefined;
      const invoke = (observation?: LangfuseSpan) => {
        operation ??= Promise.resolve().then(() => callback(observation));
        return operation;
      };
      try {
        return await startActiveObservation(name, (observation) => {
          try {
            return propagateAttributes(attributes, () => invoke(observation));
          } catch {
            return invoke();
          }
        });
      } catch {
        // Reuse the original operation, including its error; never retry AI work.
        if (operation) {
          const result = await operation;
          logger.warn(
            { event: 'telemetry.observation_failed' },
            'AI observation failed',
          );
          return result;
        }
        logger.warn(
          { event: 'telemetry.observation_failed' },
          'AI observation failed',
        );
        return invoke();
      }
    },
  );
}

export function updateAiObservation(
  observation: LangfuseSpan | undefined,
  data: Parameters<LangfuseSpan['update']>[0],
): void {
  if (!observation) return;
  try {
    const privateMode = tracePolicy.getStore()?.privateMode ?? false;
    const { input, output, ...technical } = data;
    const content = privateMode
      ? {}
      : {
          ...(input !== undefined ? { input: sanitizeTraceData(input) } : {}),
          ...(output !== undefined
            ? { output: sanitizeTraceData(output) }
            : {}),
        };
    observation.update({ ...technical, ...content });
    if (input !== undefined || output !== undefined)
      observation.setTraceIO(content);
  } catch {
    logger.warn(
      { event: 'telemetry.observation_update_failed' },
      'AI observation update failed',
    );
  }
}
