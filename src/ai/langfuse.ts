import {
  type LangfuseSpan,
  propagateAttributes,
  startActiveObservation,
} from '@langfuse/tracing';

const safeMetadataKeys = new Set([
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
  callback: (observation: LangfuseSpan) => Promise<T>,
): Promise<T> {
  const attributes = {
    ...(options.sessionId
      ? { sessionId: options.sessionId.slice(0, 200) }
      : {}),
    ...(options.userId ? { userId: options.userId.slice(0, 200) } : {}),
    metadata: normalizeAiMetadata(options.metadata),
  };

  return startActiveObservation(name, (observation) =>
    propagateAttributes(attributes, () => callback(observation)),
  );
}
