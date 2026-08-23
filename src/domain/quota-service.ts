import type { SubscriptionPlan } from '../generated/prisma/client';
import {
  createLimitNotice,
  findActiveChatSubscriptions,
  findActiveUserSubscriptions,
  findQuotaUsages,
  releaseQuotaUsage,
  reserveQuotaUsage,
  updateLimitNotice,
} from '../repositories';

export const MOSCOW_TIME_ZONE = 'Europe/Moscow';

export type QuotaKind = 'PRIMARY_RESPONSE' | 'IMAGE' | 'VOICE' | 'ANALYSIS';
export type QuotaScope = 'USER' | 'CHAT';
export type NoticeKind = 'LITE_FALLBACK' | 'IMAGE_LIMIT' | 'VOICE_LIMIT';

export interface PlanDetails {
  amount: number;
  durationDays: number;
  personal: Record<QuotaKind, number>;
  chat: Record<QuotaKind, number>;
}

export const planDetails: Record<SubscriptionPlan, PlanDetails> = {
  WEEK: {
    amount: 49,
    durationDays: 7,
    personal: {
      PRIMARY_RESPONSE: 30,
      IMAGE: 15,
      VOICE: 30,
      ANALYSIS: Infinity,
    },
    chat: { PRIMARY_RESPONSE: 3, IMAGE: 3, VOICE: 6, ANALYSIS: 1 },
  },
  MONTH: {
    amount: 99,
    durationDays: 30,
    personal: {
      PRIMARY_RESPONSE: 50,
      IMAGE: 30,
      VOICE: 60,
      ANALYSIS: Infinity,
    },
    chat: { PRIMARY_RESPONSE: 5, IMAGE: 5, VOICE: 10, ANALYSIS: 3 },
  },
  QUARTER: {
    amount: 199,
    durationDays: 90,
    personal: {
      PRIMARY_RESPONSE: 100,
      IMAGE: 50,
      VOICE: 100,
      ANALYSIS: Infinity,
    },
    chat: { PRIMARY_RESPONSE: 10, IMAGE: 10, VOICE: 20, ANALYSIS: 5 },
  },
  YEAR: {
    amount: 599,
    durationDays: 365,
    personal: {
      PRIMARY_RESPONSE: 500,
      IMAGE: 200,
      VOICE: 400,
      ANALYSIS: Infinity,
    },
    chat: {
      PRIMARY_RESPONSE: 20,
      IMAGE: 20,
      VOICE: 40,
      ANALYSIS: 10,
    },
  },
};

export const subscriptionPlanOrder: readonly SubscriptionPlan[] = [
  'WEEK',
  'MONTH',
  'QUARTER',
  'YEAR',
];

export function getPlanRank(plan: SubscriptionPlan): number {
  return subscriptionPlanOrder.indexOf(plan);
}

export function isPlanAtLeast(
  plan: SubscriptionPlan,
  minimumPlan: SubscriptionPlan,
): boolean {
  return getPlanRank(plan) >= getPlanRank(minimumPlan);
}

export const freeLimits: Record<QuotaKind, number> = {
  PRIMARY_RESPONSE: 10,
  IMAGE: 5,
  VOICE: 10,
  ANALYSIS: 1,
};

export interface QuotaReservation {
  allowed: boolean;
  source?: QuotaScope;
  ownerId?: bigint;
  chatId?: bigint;
  kind: QuotaKind;
  day: Date;
}

function moscowDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MOSCOW_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  return { year: value('year'), month: value('month'), day: value('day') };
}

export function getMoscowDay(date = new Date()): Date {
  const { year, month, day } = moscowDateParts(date);
  return new Date(Date.UTC(year, month - 1, day));
}

export function getPlanDetails(
  plan?: SubscriptionPlan | null,
): PlanDetails | null {
  return plan ? planDetails[plan] : null;
}

function sumLimits(
  subscriptions: Array<{ plan: SubscriptionPlan }>,
  scope: 'personal' | 'chat',
): Record<QuotaKind, number> {
  return Object.fromEntries(
    (Object.keys(freeLimits) as QuotaKind[]).map((kind) => {
      const limit = subscriptions.reduce((total, subscription) => {
        const value = planDetails[subscription.plan][scope][kind];
        return total === Infinity || value === Infinity
          ? Infinity
          : total + value;
      }, 0);
      return [kind, limit];
    }),
  ) as Record<QuotaKind, number>;
}

export function getPersonalDailyLimits(
  subscriptions: Array<{ plan: SubscriptionPlan }>,
): Record<QuotaKind, number> {
  if (subscriptions.length === 0) {
    return freeLimits;
  }
  return sumLimits(subscriptions, 'personal');
}

function summarizeSubscriptions<
  T extends { plan: SubscriptionPlan; endsAt: Date },
>(subscriptions: T[]): (T & { endsAt: Date }) | null {
  if (subscriptions.length === 0) return null;
  const highestPlanSubscription = subscriptions.reduce((highest, current) =>
    getPlanRank(current.plan) > getPlanRank(highest.plan) ? current : highest,
  );
  const endsAt = subscriptions.reduce(
    (latest, current) => (current.endsAt > latest ? current.endsAt : latest),
    subscriptions[0].endsAt,
  );
  return { ...highestPlanSubscription, endsAt };
}

export async function releaseQuota(
  reservation: QuotaReservation,
): Promise<void> {
  if (
    !reservation.allowed ||
    !reservation.source ||
    !reservation.ownerId ||
    reservation.chatId === undefined
  )
    return;

  await releaseQuotaUsage(
    reservation.source,
    reservation.ownerId,
    reservation.chatId,
    reservation.kind,
    reservation.day,
  );
}

export async function reserveQuota(input: {
  userId: number | bigint;
  chatId: number | bigint;
  isGroup: boolean;
  kind: QuotaKind;
  now?: Date;
}): Promise<QuotaReservation> {
  const now = input.now ?? new Date();
  const userId = BigInt(input.userId);
  const chatId = BigInt(input.chatId);
  const day = getMoscowDay(now);

  if (input.isGroup) {
    const chatSubscriptions = await findActiveChatSubscriptions(chatId, now);
    const chatLimit = sumLimits(chatSubscriptions, 'chat')[input.kind];
    if (
      chatSubscriptions.length > 0 &&
      // Group quota is keyed by (member, chat, kind, day), never by chat alone.
      (await reserveQuotaUsage(
        'CHAT',
        userId,
        chatId,
        input.kind,
        day,
        chatLimit,
      ))
    ) {
      return {
        allowed: true,
        source: 'CHAT',
        ownerId: userId,
        chatId,
        kind: input.kind,
        day,
      };
    }
  }

  const userSubscriptions = await findActiveUserSubscriptions(userId, now);
  const userLimit = getPersonalDailyLimits(userSubscriptions)[input.kind];
  const allowed = await reserveQuotaUsage(
    'USER',
    userId,
    0n,
    input.kind,
    day,
    userLimit,
  );

  return {
    allowed,
    source: allowed ? 'USER' : undefined,
    ownerId: allowed ? userId : undefined,
    chatId: allowed ? 0n : undefined,
    kind: input.kind,
    day,
  };
}

export async function getQuotaOverview(input: {
  userId: number | bigint;
  chatId?: number | bigint;
  isGroup: boolean;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const userId = BigInt(input.userId);
  const chatId = input.chatId === undefined ? undefined : BigInt(input.chatId);
  const day = getMoscowDay(now);
  const [userSubscriptions, chatSubscriptions] = await Promise.all([
    findActiveUserSubscriptions(userId, now),
    input.isGroup && chatId ? findActiveChatSubscriptions(chatId, now) : [],
  ]);
  const usages = await findQuotaUsages(userId, chatId, day);
  const used = (
    scope: QuotaScope,
    ownerId: bigint,
    usageChatId: bigint,
    kind: QuotaKind,
  ) =>
    usages.find(
      (usage) =>
        usage.scope === scope &&
        usage.ownerId === ownerId &&
        usage.chatId === usageChatId &&
        usage.kind === kind,
    )?.count ?? 0;
  const personalLimits = getPersonalDailyLimits(userSubscriptions);
  const chatLimits = sumLimits(chatSubscriptions, 'chat');

  return {
    day,
    userSubscription: summarizeSubscriptions(userSubscriptions),
    chatSubscription: summarizeSubscriptions(chatSubscriptions),
    personal: Object.fromEntries(
      (Object.keys(freeLimits) as QuotaKind[]).map((kind) => [
        kind,
        {
          limit: personalLimits[kind],
          used: used('USER', userId, 0n, kind),
        },
      ]),
    ) as Record<QuotaKind, { limit: number; used: number }>,
    chat:
      chatId && chatSubscriptions.length > 0
        ? (Object.fromEntries(
            (Object.keys(freeLimits) as QuotaKind[]).map((kind) => [
              kind,
              {
                limit: chatLimits[kind],
                used: used('CHAT', userId, chatId, kind),
              },
            ]),
          ) as Record<QuotaKind, { limit: number; used: number }>)
        : null,
  };
}

export async function shouldSendLimitNotice(input: {
  userId: number | bigint;
  chatId: number | bigint;
  kind: NoticeKind;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const userId = BigInt(input.userId);
  const chatId = BigInt(input.chatId);

  const updated = await updateLimitNotice(
    userId,
    chatId,
    input.kind,
    cutoff,
    now,
  );
  if (updated.count > 0) return true;

  try {
    await createLimitNotice(userId, chatId, input.kind, now);
    return true;
  } catch {
    return false;
  }
}

export async function getActiveSubscription(
  userId: number | bigint,
  now = new Date(),
) {
  const subscriptions = await findActiveUserSubscriptions(BigInt(userId), now);
  return summarizeSubscriptions(subscriptions);
}

export async function getMinimumPurchasablePlan(
  userId: number | bigint,
  now = new Date(),
): Promise<SubscriptionPlan | null> {
  const subscriptions = await findActiveUserSubscriptions(BigInt(userId), now);
  return summarizeSubscriptions(subscriptions)?.plan ?? null;
}
