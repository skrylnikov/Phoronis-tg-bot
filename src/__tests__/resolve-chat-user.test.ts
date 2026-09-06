import { beforeEach, expect, it, vi } from 'vitest';

const { users, aliases } = vi.hoisted(() => ({
  users: vi.fn(),
  aliases: vi.fn(),
}));
vi.mock('../repositories/user-repository', () => ({
  findManyUsersRepo: users,
}));
vi.mock('../repositories/user-alias-repository', () => ({
  findUserAliasesRepo: aliases,
}));

import { resolveChatUser } from '../domain/user/resolve-chat-user';

beforeEach(() => {
  users.mockResolvedValue([
    { id: 1n, firstName: 'Александр', lastName: 'Иванов', userName: 'sasha' },
    { id: 2n, firstName: 'Иван', lastName: null, userName: 'ivan' },
  ]);
  aliases.mockResolvedValue([
    {
      userId: 1n,
      normalizedAlias: 'шурик',
      status: 'CONFIRMED',
      confidence: 0.95,
    },
    {
      userId: 1n,
      normalizedAlias: 'санек',
      status: 'CONFIRMED',
      confidence: 0.85,
    },
  ]);
});

it('prioritizes ID and username, resolves full names and deduplicates aliases', async () => {
  for (const query of ['1', '@sasha', 'Александр Иванов', 'Шурик', 'САНЁК'])
    expect(await resolveChatUser(-100n, query)).toEqual({ senderId: 1n });
  expect(await resolveChatUser(-100n, '')).toMatchObject({
    candidates: [],
    clarificationRequired: true,
  });
  expect(aliases).toHaveBeenCalledWith(-100n);
  expect(users).toHaveBeenCalledWith(
    expect.objectContaining({
      OR: expect.arrayContaining([
        { Message: { some: { chatId: -100n, private: false } } },
      ]),
    }),
    expect.anything(),
  );
});

it('keeps ambiguous, partial and unconfirmed identities unresolved regardless of rating', async () => {
  aliases.mockResolvedValue([
    {
      userId: 1n,
      normalizedAlias: 'шурик',
      status: 'CONFIRMED',
      confidence: 0.95,
    },
    {
      userId: 2n,
      normalizedAlias: 'шурик',
      status: 'CONFIRMED',
      confidence: 0.85,
    },
    { userId: 1n, normalizedAlias: 'иван', status: 'CONFIRMED' },
    { userId: 1n, normalizedAlias: 'санек', status: 'CANDIDATE' },
  ]);
  for (const query of ['Шурик', 'Иван'])
    expect(await resolveChatUser(-100n, query)).toMatchObject({
      candidates: [{ id: '1' }, { id: '2' }],
      clarificationRequired: true,
    });
  for (const query of ['Алек', 'Санёк'])
    expect(await resolveChatUser(-100n, query)).toMatchObject({
      candidates: [{ id: '1' }],
      clarificationRequired: true,
    });
  aliases.mockResolvedValue([
    { userId: 1n, normalizedAlias: 'шурик', status: 'REJECTED' },
  ]);
  expect(await resolveChatUser(-100n, 'Шурик')).toMatchObject({
    candidates: [],
  });
});

it('does not hide ambiguity when truncating a candidate list', async () => {
  users.mockResolvedValue(
    Array.from({ length: 12 }, (_, i) => ({
      id: BigInt(i),
      firstName: 'Саша',
      lastName: null,
      userName: null,
    })),
  );
  const result = await resolveChatUser(-100n, 'Саша');
  expect(result).toMatchObject({
    truncated: true,
    clarificationRequired: true,
  });
  if ('candidates' in result) expect(result.candidates).toHaveLength(10);
});
