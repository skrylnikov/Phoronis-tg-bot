import type { User } from '@grammyjs/types';
import type { Api } from 'grammy';
import { sendPurchaseNotification } from './analytics';
import { analyzeUserMessagesForUser } from './application/user-message-analysis';
import type { BackgroundJobHandler } from './background-job-runner';
import { getPlanTitle } from './domain/subscriptions';
import type { SubscriptionPlan } from './generated/prisma/client';

interface PaymentJobPayload {
  orderId: string;
  userId: string;
  beneficiaryChatId: string;
  plan: SubscriptionPlan;
  amount: number;
  buyer: {
    firstName: string;
    lastName?: string;
    username?: string;
  };
}

function readPayload(value: unknown): PaymentJobPayload {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid payment job payload');
  }
  const payload = value as Partial<PaymentJobPayload>;
  if (
    typeof payload.orderId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.beneficiaryChatId !== 'string' ||
    typeof payload.plan !== 'string' ||
    typeof payload.amount !== 'number' ||
    !payload.buyer ||
    typeof payload.buyer.firstName !== 'string'
  ) {
    throw new Error('Invalid payment job payload');
  }
  return payload as PaymentJobPayload;
}

function telegramBuyer(
  payload: PaymentJobPayload,
): Pick<User, 'first_name' | 'last_name' | 'username'> {
  return {
    first_name: payload.buyer.firstName,
    last_name: payload.buyer.lastName,
    username: payload.buyer.username,
  };
}

function readAnalysisPayload(value: unknown): {
  userId: number;
  chatId: number;
  isGroup: boolean;
} {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid user analysis job payload');
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.userId !== 'string' ||
    typeof payload.chatId !== 'string' ||
    typeof payload.isGroup !== 'boolean'
  ) {
    throw new Error('Invalid user analysis job payload');
  }
  const userId = Number(payload.userId);
  const chatId = Number(payload.chatId);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(chatId)) {
    throw new Error('Invalid user analysis job identifiers');
  }
  return { userId, chatId, isGroup: payload.isGroup };
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('Operation aborted');
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new Error('Operation aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function createPaymentBackgroundJobHandlers(
  api: Api,
): Record<string, BackgroundJobHandler> {
  const read = (job: Parameters<BackgroundJobHandler>[0]) =>
    readPayload(job.payload);

  return {
    PAYMENT_BUYER_NOTIFICATION: async (job, signal) => {
      const payload = read(job);
      await abortable(
        api.sendMessage(
          Number(payload.userId),
          `Оплата прошла. Тариф «${getPlanTitle(payload.plan)}» активирован.`,
        ),
        signal,
      );
    },
    PAYMENT_BENEFICIARY_NOTIFICATION: async (job, signal) => {
      const payload = read(job);
      await abortable(
        api.sendMessage(
          Number(payload.beneficiaryChatId),
          `${payload.buyer.firstName} оформил(а) подписку ${getPlanTitle(payload.plan)} и подарил(а) этому чату увеличенные лимиты ✨`,
        ),
        signal,
      );
    },
    PAYMENT_ANALYTICS_NOTIFICATION: async (job, signal) => {
      const payload = read(job);
      await abortable(
        sendPurchaseNotification({
          api,
          buyer: telegramBuyer(payload),
          beneficiaryChatId: BigInt(payload.beneficiaryChatId),
          plan: payload.plan,
          amount: payload.amount,
        }),
        signal,
      );
    },
    USER_MESSAGE_ANALYSIS: async (job, signal) => {
      await abortable(
        analyzeUserMessagesForUser(readAnalysisPayload(job.payload)),
        signal,
      );
    },
  };
}
