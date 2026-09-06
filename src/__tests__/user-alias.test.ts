import { describe, expect, it } from 'vitest';
import {
  aggregateAlias,
  normalizeAlias,
  selectAddressing,
  validateAlias,
} from '../domain/user/aliases';

describe('alias normalization and evidence', () => {
  it('selects owner preference before neutral independent evidence, with stable fallback', () => {
    const automatic = {
      alias: 'Шурик',
      normalizedAlias: 'шурик',
      confidence: 0.92,
      confirmationCount: 5,
      authorCount: 2,
      neutralForAddressing: true,
      lastObservedAt: 1,
      status: 'CONFIRMED' as const,
      preferred: false,
      addressingBlocked: false,
    };
    const owner = {
      ...automatic,
      alias: 'Саша',
      normalizedAlias: 'саша',
      confidence: 1,
      authorCount: 0,
      preferred: true,
    };
    expect(selectAddressing([automatic, owner], 'Александр')).toBe('Саша');
    expect(selectAddressing([automatic], 'Александр')).toBe('Шурик');
    for (const patch of [
      { confidence: 0.8999 },
      { authorCount: 1 },
      { neutralForAddressing: false },
      { addressingBlocked: true },
      { status: 'REJECTED' as const },
    ])
      expect(selectAddressing([{ ...automatic, ...patch }], 'Александр')).toBe(
        'Александр',
      );
    expect(
      selectAddressing([{ ...automatic, confidence: 0.9 }], 'Александр'),
    ).toBe('Шурик');
    expect(
      selectAddressing(
        [
          automatic,
          { ...owner, preferred: false, confidence: 0.92, authorCount: 2 },
        ],
        'Александр',
      ),
    ).toBe('Саша');
    expect(selectAddressing([], 'Александр')).toBe('Александр');
  });
  it('normalizes Unicode, case, spaces and ё without accepting IDs or controls', () => {
    expect(normalizeAlias('  САНЁК  Иванов  ')).toBe('санек иванов');
    expect(validateAlias(' Ａlex ')).toEqual({
      alias: 'Alex',
      normalizedAlias: 'alex',
    });
    expect(validateAlias('😀'.repeat(64))).not.toBeNull();
    for (const value of [
      '',
      '  ',
      '\tСаша',
      'Са\u200bша',
      '😀'.repeat(65),
      '123',
      '-123',
      '+１２３',
      '@sasha',
      null,
    ])
      expect(validateAlias(value)).toBeNull();
  });

  it('recalculates chronological daily evidence and independent authors', () => {
    const evidence = Array.from({ length: 5 }, (_, i) => ({
      modelConfidence: 0.8,
      neutralForAddressing: true,
      sourceMessage: {
        id: BigInt(i + 1),
        senderId: BigInt((i % 2) + 1),
        sentAt: new Date(Date.UTC(2026, 8, i + 1)),
        private: false,
      },
    }));
    for (const [i, expected] of [0.8, 0.84, 0.872, 0.8976, 0.91808].entries())
      expect(aggregateAlias(evidence.slice(0, i + 1)).confidence).toBeCloseTo(
        expected,
        10,
      );
    expect(aggregateAlias([...evidence].reverse())).toEqual(
      aggregateAlias(evidence),
    );
    expect(aggregateAlias([...evidence, ...evidence])).toEqual(
      aggregateAlias(evidence),
    );
    expect(aggregateAlias(evidence)).toMatchObject({
      status: 'CONFIRMED',
      confirmationCount: 5,
      authorCount: 2,
    });
    expect(aggregateAlias(evidence.slice(0, 1))).toMatchObject({
      status: 'CANDIDATE',
    });
    expect(aggregateAlias([], true)).toMatchObject({
      confidence: 1,
      status: 'CONFIRMED',
    });
    expect(aggregateAlias(evidence, true, true)).toMatchObject({
      confidence: 0,
      status: 'REJECTED',
    });
    const first = evidence[0];
    if (!first) throw new Error('Missing evidence fixture');
    expect(
      aggregateAlias([{ ...first, modelConfidence: 0.5 }]).confirmationCount,
    ).toBe(1);
    expect(
      aggregateAlias([{ ...first, modelConfidence: 0.499 }]).confirmationCount,
    ).toBe(0);
    expect(
      aggregateAlias([
        { ...first, sourceMessage: { ...first.sourceMessage, private: true } },
      ]).confidence,
    ).toBe(0);
    const sameAuthor = ['2026-09-01T20:59:00Z', '2026-09-01T21:00:00Z'].map(
      (date, i) => ({
        ...first,
        sourceMessage: {
          ...first.sourceMessage,
          id: BigInt(i),
          sentAt: new Date(date),
        },
      }),
    );
    expect(aggregateAlias(sameAuthor)).toMatchObject({
      confirmationCount: 2,
      authorCount: 1,
      status: 'CANDIDATE',
    });
  });
});
