import type { Message } from '../../generated/prisma/client';
export type AnalysisMessage = Message & { replyToMessage?: Message | null };
export interface AnalysisWindow {
  windowVersion: 1;
  cutoffAt: string;
  baseMessageIds: string[];
  replyMessageIds?: string[];
  repliesTruncated?: boolean;
}
export function readAnalysisWindow(payload: unknown): AnalysisWindow | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Partial<AnalysisWindow>;
  if (value.windowVersion === undefined) return null;
  const ids = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.every((id) => typeof id === 'string' && /^\d+$/u.test(id));
  if (
    value.windowVersion !== 1 ||
    typeof value.cutoffAt !== 'string' ||
    !Number.isFinite(Date.parse(value.cutoffAt)) ||
    !ids(value.baseMessageIds) ||
    value.baseMessageIds.length > 30 ||
    (value.replyMessageIds !== undefined &&
      (!ids(value.replyMessageIds) || value.replyMessageIds.length > 60))
  )
    throw new Error('Invalid analysis window');
  return value as AnalysisWindow;
}
export function chooseAnalysisReplies(
  base: AnalysisMessage[],
  candidates: AnalysisMessage[],
) {
  const baseIds = new Set(base.map((m) => m.id));
  const parents = new Set(
    base.flatMap((m) =>
      m.replyToMessageId === null ? [] : [m.replyToMessageId],
    ),
  );
  const ordered = [...candidates].sort(
    (a, b) =>
      Number(parents.has(b.id)) - Number(parents.has(a.id)) ||
      a.sentAt.getTime() - b.sentAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const selected: AnalysisMessage[] = [];
  const seen = new Set(baseIds);
  let characters = 0;
  let truncated = false;
  for (const message of ordered) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    const size = (message.text ?? message.summary ?? '').length;
    if (selected.length >= 60 || characters + size > 24_000) {
      truncated = true;
      break;
    }
    selected.push(message);
    characters += size;
  }
  return {
    replyMessageIds: selected.map((m) => String(m.id)),
    repliesTruncated: truncated,
  };
}
export function attachAnalysisParents(
  base: AnalysisMessage[],
  replies: AnalysisMessage[],
) {
  const all = new Map([...base, ...replies].map((m) => [m.id, m]));
  return [...all.values()]
    .map((m) => ({
      ...m,
      replyToMessage:
        m.replyToMessageId === null
          ? null
          : (all.get(m.replyToMessageId) ?? null),
    }))
    .sort(
      (a, b) =>
        a.sentAt.getTime() - b.sentAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

export function filterAnalysisReplies(
  base: AnalysisMessage[],
  replies: AnalysisMessage[],
) {
  const baseIds = new Set(base.map((m) => m.id));
  return replies.filter(
    (m) =>
      base.some((b) => b.replyToMessageId === m.id) ||
      (m.replyToMessageId !== null && baseIds.has(m.replyToMessageId)),
  );
}
