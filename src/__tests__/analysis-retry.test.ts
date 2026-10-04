import { expect, it } from 'vitest';
import { parseAnalysisRetryArgs } from '../application/analysis-retry';

it('requires bounded explicit scope and defaults to preview', () => {
  expect(parseAnalysisRetryArgs(['--chat-id=-100'])).toMatchObject({
    chatId: -100n,
    limit: 10,
    apply: false,
  });
  expect(
    parseAnalysisRetryArgs(['--chat-id=-100', '--user-id=42', '--apply']),
  ).toMatchObject({ userId: 42n, apply: true });
  expect(parseAnalysisRetryArgs(['--help'])).toEqual({ help: true });
  for (const args of [
    [],
    ['--chat-id=bad'],
    ['--chat-id=-100', '--limit=101'],
    ['--chat-id=-100', '--limit=0'],
    ['--chat-id=-100', '--from=2026-10-04'],
    [
      '--chat-id=-100',
      '--from=2026-10-04T00:00:00Z',
      '--to=2026-10-01T00:00:00Z',
    ],
    ['--chat-id=-100', '--unknown'],
  ])
    expect(() => parseAnalysisRetryArgs(args)).toThrow();
});
