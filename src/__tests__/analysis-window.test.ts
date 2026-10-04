import { expect, it } from 'vitest';
import {
  type AnalysisMessage,
  attachAnalysisParents,
  chooseAnalysisReplies,
  readAnalysisWindow,
} from '../domain/user/analysis-window';

const message = (id: bigint, patch: Partial<AnalysisMessage> = {}) =>
  ({
    id,
    chatId: 1n,
    senderId: 42n,
    text: 'hello',
    sentAt: new Date(0),
    private: false,
    replyToMessageId: null,
    ...patch,
  }) as AnalysisMessage;
it('prioritizes parents, deduplicates IDs and stops at whole-message limits', () => {
  const base = [message(100n, { replyToMessageId: 1n })];
  const replies = Array.from({ length: 70 }, (_, i) =>
    message(BigInt(i + 1), { replyToMessageId: 100n }),
  );
  const selected = chooseAnalysisReplies(base, [
    ...replies.reverse(),
    replies[0],
    base[0],
  ]);
  expect(selected).toEqual({
    replyMessageIds: Array.from({ length: 60 }, (_, i) => String(i + 1)),
    repliesTruncated: true,
  });
  expect(
    chooseAnalysisReplies(base, [message(1n, { text: 'x'.repeat(24001) })]),
  ).toEqual({ replyMessageIds: [], repliesTruncated: true });
  const attached = attachAnalysisParents(base, [message(1n)]);
  expect(attached.find((m) => m.id === 100n)?.replyToMessage?.id).toBe(1n);
});
it('validates window payload and never silently accepts malformed fixed anchors', () => {
  expect(readAnalysisWindow({ userId: '42' })).toBeNull();
  for (const value of [
    { windowVersion: 2 },
    { windowVersion: 1, cutoffAt: 'bad', baseMessageIds: [] },
    {
      windowVersion: 1,
      cutoffAt: new Date().toISOString(),
      baseMessageIds: ['fake'],
    },
  ])
    expect(() => readAnalysisWindow(value)).toThrow();
});
