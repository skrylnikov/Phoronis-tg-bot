import { describe, expect, it } from 'vitest';
import { isChatHistorySearchIntent } from '../ai/history-intent';

describe('isChatHistorySearchIntent', () => {
  it('recognizes a direct question about an old discussion', () => {
    expect(
      isChatHistorySearchIntent('Ио, когда мы обсуждали фильмы?', undefined),
    ).toBe(true);
  });

  it('recognizes a follow-up to a history answer', () => {
    expect(
      isChatHistorySearchIntent(
        'а игр?',
        'Тоже нет, в доступной истории ни фильмов, ни сериалов не нашла.',
      ),
    ).toBe(true);
  });

  it('does not force history search for an ordinary question', () => {
    expect(
      isChatHistorySearchIntent('Посоветуй хороший фильм', 'Попробую помочь.'),
    ).toBe(false);
  });
});
