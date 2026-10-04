import { describe, expect, it } from 'vitest';
import {
  decisionReportJson,
  decisionReportOptions,
  formatDecisionReport,
} from '../domain/user/decision-report';

describe('decision review report', () => {
  it('validates the period, sample budget and signed Telegram ID', () => {
    expect(
      decisionReportOptions([
        '--',
        '--days',
        '2',
        '--limit',
        '10',
        '--chat-id',
        '-100123',
        '--json',
      ]),
    ).toMatchObject({ days: 2, limit: 10, chatId: -100123n, json: true });
    for (const args of [
      ['--days', '0'],
      ['--days', '8'],
      ['--limit', '201'],
      ['--limit', '1.5'],
      ['--chat-id', 'oops'],
    ]) {
      expect(() => decisionReportOptions(args)).toThrow();
    }
  });

  it('distinguishes an empty sample from demonstrated quality', () => {
    const output = formatDecisionReport({
      since: new Date('2026-10-01'),
      until: new Date('2026-10-04'),
      total: 0,
      groups: [],
      examples: [],
      latency: { averageMs: null, maxMs: null },
    });
    expect(output).toContain('данных нет');
    expect(output).toContain('не точность модели');
    expect(output).toContain('review_write_failed');
  });

  it('emits valid JSON with exact bigint IDs', () => {
    expect(
      JSON.parse(decisionReportJson({ sourceChatId: -1001234567890123456n })),
    ).toEqual({ sourceChatId: '-1001234567890123456' });
  });
});
