import { afterEach, describe, expect, it } from 'vitest';
import {
  getAnalyticsRuntimeSnapshot,
  recordAiAttempt,
  recordAiFailure,
  recordAiSuccess,
  recordVectorSearch,
  resetAnalyticsRuntimeForTests,
} from '../analytics-runtime';

afterEach(() => {
  resetAnalyticsRuntimeForTests();
});

describe('analytics runtime counters', () => {
  it('counts vector context and AI outcomes for one Moscow day', () => {
    const now = new Date('2026-08-23T20:30:00.000Z');

    recordVectorSearch(2, now);
    recordVectorSearch(0, now);
    recordAiAttempt(now);
    recordAiSuccess(120, now);
    recordAiAttempt(now);
    recordAiFailure(80, now);

    expect(getAnalyticsRuntimeSnapshot(now)).toMatchObject({
      vectorSearches: 2,
      vectorSearchesWithHits: 1,
      contextMessagesAdded: 2,
      aiAttempts: 2,
      aiSuccesses: 1,
      aiFailures: 1,
      latencyMs: [120, 80],
    });
  });

  it('starts vector counters from zero after 00:00 Moscow time', () => {
    const beforeMidnight = new Date('2026-08-23T20:59:59.000Z');
    const afterMidnight = new Date('2026-08-23T21:00:00.000Z');

    recordVectorSearch(3, beforeMidnight);

    expect(getAnalyticsRuntimeSnapshot(afterMidnight)).toMatchObject({
      vectorSearches: 0,
      vectorSearchesWithHits: 0,
      contextMessagesAdded: 0,
    });
  });
});
