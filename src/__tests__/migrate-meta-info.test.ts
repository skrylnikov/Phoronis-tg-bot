import { describe, expect, it } from 'vitest';
import { convertMetaInfoToFacts } from '../domain/user/migrate-meta-info';

describe('legacy User.metaInfo migration', () => {
  it('keeps historical categories available as UserFact-compatible records', () => {
    expect(
      convertMetaInfoToFacts({
        interests: [{ value: 'Rust', weight: 3 }],
        communication_style: [{ value: 'Кратко', weight: 2 }],
        notable_traits: [{ value: 'Любопытный', weight: 4 }],
        topics: [{ value: 'Фильмы', weight: 1 }],
        notes: [{ value: 'Старый профиль', weight: 5 }],
      }),
    ).toEqual([
      { content: 'Rust', type: 'INTEREST', weight: 3 },
      { content: 'Кратко', type: 'TEXT_STYLE', weight: 2 },
      { content: 'Любопытный', type: 'FACT', weight: 4 },
      { content: 'Фильмы', type: 'INTEREST', weight: 1 },
      { content: 'Старый профиль', type: 'FACT', weight: 5 },
    ]);
  });
});
