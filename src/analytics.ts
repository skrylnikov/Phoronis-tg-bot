import type { User } from '@grammyjs/types';
import type { Api } from 'grammy';
import { chatModelId, liteChatModelId } from './ai/model-ids';
import {
  type AnalyticsRuntimeSnapshot,
  getAnalyticsRuntimeSnapshot,
} from './analytics-runtime';
import { analyticsChatId } from './config';
import { getMoscowDay, MOSCOW_TIME_ZONE } from './domain/quota-service';
import { getPlanTitle } from './domain/subscriptions';
import type { SubscriptionPlan } from './generated/prisma/client';
import {
  aggregatePaidOrders,
  aggregateRefundedOrders,
  countActiveSubscriptions,
  countUserFactsInRange,
  findChatById,
  findDailyAnalytics,
  findMessageActivityInRange,
  findModelIdsInRange,
  groupQuotaUsageByKind,
  updateDailyAnalyticsReportSent,
  upsertDailyAnalytics,
} from './repositories';

const moscowOffsetMs = 3 * 60 * 60 * 1000;

function getMoscowDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MOSCOW_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
  };
}

function getMoscowDayRange(date: Date): { start: Date; end: Date } {
  const { year, month, day } = getMoscowDateParts(date);
  const start = new Date(Date.UTC(year, month - 1, day) - moscowOffsetMs);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function formatBuyer(
  buyer: Pick<User, 'first_name' | 'last_name' | 'username'>,
): string {
  const name = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ');
  return buyer.username
    ? `${name || 'Пользователь'} (@${buyer.username})`
    : name || 'Пользователь без username';
}

export async function sendPurchaseNotification(input: {
  api: Api;
  buyer: Pick<User, 'first_name' | 'last_name' | 'username'>;
  beneficiaryChatId: bigint;
  plan: SubscriptionPlan;
  amount: number;
}): Promise<number> {
  const chat = await findChatById(input.beneficiaryChatId);
  const message = await input.api.sendMessage(
    analyticsChatId,
    [
      'Новая подписка',
      `Покупатель: ${formatBuyer(input.buyer)}`,
      `Чат: ${chat?.title ?? input.beneficiaryChatId.toString()}`,
      `Тариф: ${getPlanTitle(input.plan)}`,
      `Сумма: ${input.amount} ⭐`,
    ].join('\n'),
  );
  return message.message_id;
}

export interface AnalyticsSnapshot {
  date: Date;
  start: Date;
  end: Date;
  activity: Awaited<ReturnType<typeof findMessageActivityInRange>>;
  models: {
    expensive: Record<string, number>;
    cheap: Record<string, number>;
    other: Record<string, number>;
  };
  quota: {
    image: number;
    voice: number;
    primaryResponse: number;
    analysis: number;
  };
  facts: { created: number };
  purchases: { count: number; amount: number };
  refunds: { count: number; amount: number };
  activeSubscriptions: number;
  runtime: AnalyticsRuntimeSnapshot;
}

function sumModelCounts(models: Record<string, number>): number {
  return Object.values(models).reduce((total, count) => total + count, 0);
}

function groupModelIds(modelIds: string[]): AnalyticsSnapshot['models'] {
  const result: AnalyticsSnapshot['models'] = {
    expensive: {},
    cheap: {},
    other: {},
  };
  for (const modelId of modelIds) {
    const group =
      modelId === chatModelId
        ? result.expensive
        : modelId === liteChatModelId
          ? result.cheap
          : result.other;
    group[modelId] = (group[modelId] ?? 0) + 1;
  }
  return result;
}

function getQuotaCount(
  usages: Awaited<ReturnType<typeof groupQuotaUsageByKind>>,
  kind: 'PRIMARY_RESPONSE' | 'IMAGE' | 'VOICE' | 'ANALYSIS',
): number {
  return usages.find((usage) => usage.kind === kind)?._sum.count ?? 0;
}

export async function buildAnalyticsSnapshot(
  botUserId: number | bigint,
  now = new Date(),
): Promise<AnalyticsSnapshot> {
  const date = getMoscowDay(now);
  const { start } = getMoscowDayRange(now);
  const end = now;
  const [
    activity,
    usages,
    modelIds,
    factsCreated,
    paid,
    refunded,
    activeSubscriptions,
  ] = await Promise.all([
    findMessageActivityInRange(start, end, BigInt(botUserId)),
    groupQuotaUsageByKind(date),
    findModelIdsInRange(start, end, BigInt(botUserId)),
    countUserFactsInRange(start, end),
    aggregatePaidOrders(start, end),
    aggregateRefundedOrders(start, end),
    countActiveSubscriptions(now),
  ]);

  return {
    date,
    start,
    end,
    activity,
    models: groupModelIds(modelIds),
    quota: {
      image: getQuotaCount(usages, 'IMAGE'),
      voice: getQuotaCount(usages, 'VOICE'),
      primaryResponse: getQuotaCount(usages, 'PRIMARY_RESPONSE'),
      analysis: getQuotaCount(usages, 'ANALYSIS'),
    },
    facts: { created: factsCreated },
    purchases: {
      count: paid._count._all,
      amount: paid._sum.amount ?? 0,
    },
    refunds: {
      count: refunded._count._all,
      amount: refunded._sum.amount ?? 0,
    },
    activeSubscriptions,
    runtime: getAnalyticsRuntimeSnapshot(now),
  };
}

function formatModelCounts(models: Record<string, number>): string {
  const entries = Object.entries(models);
  return entries.length === 0
    ? '0'
    : entries.map(([modelId, count]) => `${modelId}: ${count}`).join(', ');
}

function formatLatency(latencyMs: number[]): string {
  if (latencyMs.length === 0) return '0 мс / 0 мс';
  const sorted = [...latencyMs].sort((a, b) => a - b);
  const average = Math.round(
    sorted.reduce((total, value) => total + value, 0) / sorted.length,
  );
  const p95 = Math.round(
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
  );
  return `${average} мс / ${p95} мс`;
}

export function formatAnalyticsReport(snapshot: AnalyticsSnapshot): string {
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: MOSCOW_TIME_ZONE,
    day: 'numeric',
    month: 'long',
  }).format(snapshot.end);
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: MOSCOW_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
  }).format(snapshot.end);
  const runtimeNote = snapshot.runtime.isPartial
    ? ' (с момента запуска процесса; неполный день)'
    : '';
  const responseRate = snapshot.runtime.aiAttempts
    ? Math.round(
        (snapshot.runtime.aiSuccesses / snapshot.runtime.aiAttempts) * 100,
      )
    : 0;

  return [
    `Статистика Phoronis за ${date} (до ${time} МСК)`,
    `• Сообщений в базе: ${snapshot.activity.incomingMessages} (личных: ${snapshot.activity.incomingMessagesByChatType.private}, групповых: ${snapshot.activity.incomingMessagesByChatType.group})`,
    `• Увидели чатов: ${snapshot.activity.seenChats} (личных: ${snapshot.activity.incomingByChatType.private}, групповых: ${snapshot.activity.incomingByChatType.group})`,
    `• Увидели пользователей: ${snapshot.activity.seenUsers}`,
    `• Ответили чатов: ${snapshot.activity.answeredChats} (личных: ${snapshot.activity.answeredByChatType.private}, групповых: ${snapshot.activity.answeredByChatType.group})`,
    `• Ответили пользователей: ${snapshot.activity.answeredUsers}`,
    `• Связанных ответов: ${snapshot.activity.answeredMessages} (личных: ${snapshot.activity.answeredMessagesByChatType.private}, групповых: ${snapshot.activity.answeredMessagesByChatType.group})`,
    `• Дорогие AI-ответы: ${sumModelCounts(snapshot.models.expensive)} (${formatModelCounts(snapshot.models.expensive)})`,
    `• Дешёвые AI-ответы: ${sumModelCounts(snapshot.models.cheap)} (${formatModelCounts(snapshot.models.cheap)})`,
    `• Ответы с другими model ID: ${formatModelCounts(snapshot.models.other)}`,
    `• Пользовательская аналитика: ${snapshot.quota.analysis}`,
    `• Новых фактов: ${snapshot.facts.created}`,
    `• Vector search: ${snapshot.runtime.vectorSearches}, с результатами: ${snapshot.runtime.vectorSearchesWithHits}, добавлено в контекст: ${snapshot.runtime.contextMessagesAdded}${runtimeNote}`,
    `• Успешных AI-ответов: ${snapshot.runtime.aiSuccesses}${runtimeNote}`,
    `• Неуспешных попыток AI: ${snapshot.runtime.aiFailures}${runtimeNote}`,
    `• Доля успешных ответов: ${responseRate}%${runtimeNote}`,
    `• Средняя / p95 задержка: ${formatLatency(snapshot.runtime.latencyMs)}${runtimeNote}`,
    `• Распознано изображений: ${snapshot.quota.image}`,
    `• Распознано голосовых: ${snapshot.quota.voice}`,
    `• Покупок: ${snapshot.purchases.count} на ${snapshot.purchases.amount} ⭐`,
    `• Возвратов: ${snapshot.refunds.count} на ${snapshot.refunds.amount} ⭐`,
    `• Активных подписок сейчас: ${snapshot.activeSubscriptions}`,
  ].join('\n');
}

export async function sendDailyAnalyticsReport(
  api: Api,
  botUserId: number | bigint,
  now = new Date(),
): Promise<boolean> {
  const dateParts = getMoscowDateParts(now);
  if (dateParts.hour < 23) return false;

  const day = getMoscowDay(now);
  const existing = await findDailyAnalytics(day);
  if (existing?.reportSentAt) return false;
  await upsertDailyAnalytics(day);
  const snapshot = await buildAnalyticsSnapshot(botUserId, now);

  await api.sendMessage(analyticsChatId, formatAnalyticsReport(snapshot));
  await updateDailyAnalyticsReportSent(day, now);
  return true;
}
