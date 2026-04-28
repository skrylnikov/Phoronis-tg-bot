const analysisTimestamps = new Map<string, Date[]>();

const WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 5;

function getKey(userId: bigint, chatId: bigint): string {
  return `${chatId.toString()}:${userId.toString()}`;
}

export function canAnalyze(
  userId: bigint,
  chatId: bigint,
  limit = DEFAULT_LIMIT,
): boolean {
  const key = getKey(userId, chatId);
  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS);

  const existing = analysisTimestamps.get(key) ?? [];
  const recent = existing.filter((t) => t > cutoff);

  if (recent.length >= limit) {
    return false;
  }

  recent.push(now);
  analysisTimestamps.set(key, recent);
  return true;
}
