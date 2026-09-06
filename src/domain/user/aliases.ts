export const minimumAliasConfidence = 0.5;
export const confirmedAliasConfidence = 0.8;
export const addressingAliasConfidence = 0.9;
export const aliasConfirmationWeight = 0.25;

export function normalizeAlias(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase()
    .replaceAll('ё', 'е');
}

export function validateAlias(
  value: unknown,
): { alias: string; normalizedAlias: string } | null {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const alias = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (
    !alias ||
    [...alias].length > 64 ||
    /^[+-]?\d+$/u.test(alias) ||
    alias.startsWith('@')
  )
    return null;
  return { alias, normalizedAlias: normalizeAlias(alias) };
}

type AliasEvidence = {
  modelConfidence: number;
  neutralForAddressing: boolean;
  sourceMessage: {
    id: bigint;
    senderId: bigint;
    sentAt: Date;
    private: boolean | null;
  };
};

const moscowDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function aggregateAlias(
  evidence: AliasEvidence[],
  ownerConfirmed = false,
  rejected = false,
) {
  const days = new Set<string>();
  const authors = new Set<bigint>();
  let confidence = 0;
  let neutralForAddressing = true;
  let lastObservedAt = 0;
  const ordered = evidence
    .filter(
      (item) =>
        item.sourceMessage.private === false &&
        Number.isFinite(item.modelConfidence) &&
        item.modelConfidence >= minimumAliasConfidence &&
        item.modelConfidence <= 1,
    )
    .sort(
      (a, b) =>
        a.sourceMessage.sentAt.getTime() - b.sourceMessage.sentAt.getTime() ||
        (a.sourceMessage.id < b.sourceMessage.id
          ? -1
          : a.sourceMessage.id > b.sourceMessage.id
            ? 1
            : 0),
    );
  for (const item of ordered) {
    const source = item.sourceMessage;
    const key = `${source.senderId}:${moscowDay.format(source.sentAt)}`;
    if (days.has(key)) continue;
    confidence =
      days.size === 0
        ? item.modelConfidence
        : confidence +
          (1 - confidence) * item.modelConfidence * aliasConfirmationWeight;
    days.add(key);
    authors.add(source.senderId);
    neutralForAddressing &&= item.neutralForAddressing;
    lastObservedAt = source.sentAt.getTime();
  }
  return {
    confidence: rejected ? 0 : ownerConfirmed ? 1 : confidence,
    confirmationCount: days.size,
    authorCount: authors.size,
    neutralForAddressing,
    lastObservedAt,
    status: rejected
      ? ('REJECTED' as const)
      : ownerConfirmed ||
          (confidence >= confirmedAliasConfidence && authors.size >= 2)
        ? ('CONFIRMED' as const)
        : ('CANDIDATE' as const),
  };
}

type AddressAlias = ReturnType<typeof aggregateAlias> & {
  alias: string;
  normalizedAlias: string;
  preferred: boolean;
  addressingBlocked: boolean;
};

export function selectAddressing(aliases: AddressAlias[], profileName: string) {
  const available = aliases.filter(
    (alias) => alias.status === 'CONFIRMED' && !alias.addressingBlocked,
  );
  const preferred = available.find((alias) => alias.preferred);
  if (preferred) return preferred.alias;
  return (
    available
      .filter(
        (alias) =>
          alias.confidence >= addressingAliasConfidence &&
          alias.authorCount >= 2 &&
          alias.neutralForAddressing,
      )
      .sort(
        (a, b) =>
          b.confidence - a.confidence ||
          b.confirmationCount - a.confirmationCount ||
          b.lastObservedAt - a.lastObservedAt ||
          (a.normalizedAlias < b.normalizedAlias
            ? -1
            : a.normalizedAlias > b.normalizedAlias
              ? 1
              : 0),
      )[0]?.alias ?? profileName
  );
}
