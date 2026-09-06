import { findUserAliasesRepo } from '../../repositories/user-alias-repository';
import { findManyUsersRepo } from '../../repositories/user-repository';
import { normalizeAlias } from './aliases';

export type SenderMatch =
  | { senderId: bigint }
  | {
      candidates: Array<{ id: string; sender: string }>;
      truncated: boolean;
      clarificationRequired: true;
    };

export async function resolveChatUser(
  chatId: bigint,
  query: string,
): Promise<SenderMatch> {
  const normalized = normalizeAlias(query);
  if (!normalized)
    return { candidates: [], truncated: false, clarificationRequired: true };
  if (/^\d+$/.test(normalized)) return { senderId: BigInt(normalized) };
  const [users, aliases] = await Promise.all([
    findManyUsersRepo(
      {
        OR: [
          { Message: { some: { chatId, private: false } } },
          { aliases: { some: { chatId } } },
        ],
      },
      { select: { id: true, firstName: true, lastName: true, userName: true } },
    ),
    findUserAliasesRepo(chatId),
  ]);
  const explicitUsername = normalized.startsWith('@');
  const exact = new Map<bigint, (typeof users)[number]>();
  const partial = new Map<bigint, (typeof users)[number]>();
  for (const user of users) {
    if (explicitUsername) {
      if (normalizeAlias(user.userName ?? '') === normalized.slice(1))
        exact.set(user.id, user);
      continue;
    }
    const names = [
      user.firstName,
      user.lastName,
      user.userName,
      [user.firstName, user.lastName].filter(Boolean).join(' '),
    ]
      .filter((name): name is string => Boolean(name))
      .map(normalizeAlias);
    const userAliases = aliases.filter(
      (alias) => alias.userId === user.id && alias.status !== 'REJECTED',
    );
    if (
      names.includes(normalized) ||
      userAliases.some(
        (alias) =>
          alias.normalizedAlias === normalized && alias.status === 'CONFIRMED',
      )
    )
      exact.set(user.id, user);
    else if (
      names.some((name) => name.includes(normalized)) ||
      userAliases.some((alias) => alias.normalizedAlias.includes(normalized))
    )
      partial.set(user.id, user);
  }
  const firstExact = exact.keys().next().value;
  if (exact.size === 1 && firstExact !== undefined)
    return { senderId: firstExact };
  const matches = [...(exact.size ? exact : partial).values()].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );
  return {
    clarificationRequired: true,
    truncated: matches.length > 10,
    candidates: matches.slice(0, 10).map((user) => ({
      id: String(user.id),
      sender: user.userName
        ? `@${user.userName}`
        : [user.firstName, user.lastName].filter(Boolean).join(' ') ||
          'Неизвестный пользователь',
    })),
  };
}
