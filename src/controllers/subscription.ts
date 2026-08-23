import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../bot';
import { paymentSupportContact } from '../config';
import {
  acceptPurchaseTerms,
  activatePayment,
  createPaymentOrder,
  createPurchaseSession,
  formatInvoiceDescription,
  formatPaymentTerms,
  formatSubscriptionCatalog,
  getActiveSubscription,
  getInvoicePayload,
  getMinimumPurchasablePlan,
  getPlanTitle,
  getPurchaseOptions,
  getPurchaseSession,
  getQuotaOverview,
  PurchaseValidationError,
  paymentTermsVersion,
  refundPayment,
  saveChat,
  saveUser,
  subscriptionPlans,
  validatePaymentOrder,
} from '../domain';
import type { SubscriptionPlan } from '../generated/prisma/client';
import { logger } from '../logger';

function isGroup(ctx: BotContext): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

function formatQuota(value: { limit: number; used: number }): string {
  if (value.limit === Infinity) return 'безлимит';
  return `${Math.max(0, value.limit - value.used)}/${value.limit}`;
}

function planFromValue(value: string): SubscriptionPlan | null {
  return subscriptionPlans.includes(value as SubscriptionPlan)
    ? (value as SubscriptionPlan)
    : null;
}

const paymentTermsText = formatPaymentTerms();

const acceptedPaymentTermsText = `${paymentTermsText}

✅ Условия приняты`;

function subscriptionKeyboard(
  token: string,
  options: Awaited<ReturnType<typeof getPurchaseOptions>>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const option of options) {
    keyboard.text(
      `${getPlanTitle(option.plan)} — ${option.amount} ⭐${option.actualDiscount > 0 ? ` (−${option.actualDiscount}%)` : ''}`,
      `subscription:${option.plan}:${token}`,
    );
    keyboard.row();
  }
  return keyboard;
}

export async function subscribeController(ctx: BotContext): Promise<void> {
  const chat = ctx.chat;
  if (!ctx.from || !ctx.chatId || !chat) return;
  if (!isGroup(ctx)) {
    await ctx.reply(
      'Откройте /subscribe в группе, которой хотите подарить групповые лимиты.',
    );
    return;
  }

  await Promise.all([saveChat(chat), saveUser(ctx.from), saveUser(ctx.me)]);

  const session = await createPurchaseSession({
    userId: ctx.from.id,
    beneficiaryChatId: ctx.chatId,
  });
  const url = ctx.me.username
    ? `https://t.me/${ctx.me.username}?start=buy_${session.token}`
    : undefined;
  await ctx.reply('Откройте покупку в личном чате с ботом.', {
    ...(url
      ? {
          reply_markup: new InlineKeyboard().url('Выбрать подписку', url),
        }
      : {}),
  });
}

export async function startSubscriptionController(
  ctx: BotContext,
): Promise<boolean> {
  if (!ctx.from || !ctx.chat || ctx.chat.type !== 'private' || !ctx.msg?.text) {
    return false;
  }
  const match = /^\/start\s+buy_([a-z0-9]+)$/i.exec(ctx.msg.text);
  if (!match) return false;

  const session = await getPurchaseSession(match[1], ctx.from.id);
  if (!session) {
    await ctx.reply(
      'Ссылка на покупку устарела. Откройте /subscribe в нужной группе ещё раз.',
    );
    return true;
  }

  await ctx.reply(paymentTermsText, {
    reply_markup: new InlineKeyboard().text(
      'Принимаю условия',
      `subscription:accept:${session.token}`,
    ),
  });
  return true;
}

export async function subscriptionCallbackController(
  ctx: BotContext,
): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from || !ctx.chatId) return;
  const acceptance = /^subscription:accept:([a-z0-9]+)$/i.exec(data);
  if (acceptance) {
    const session = await acceptPurchaseTerms(acceptance[1], ctx.from.id);
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'Ссылка устарела' });
      return;
    }
    await ctx.editMessageText(acceptedPaymentTermsText);
    const [options, minimumPlan] = await Promise.all([
      getPurchaseOptions(ctx.from.id),
      getMinimumPurchasablePlan(ctx.from.id),
    ]);
    await ctx.answerCallbackQuery({ text: 'Условия приняты' });
    await ctx.reply(
      [
        formatSubscriptionCatalog(options),
        minimumPlan
          ? `Выберите тариф не ниже «${getPlanTitle(minimumPlan)}». Новые дни и лимиты добавятся к активной подписке.`
          : 'Выберите тариф. Личные и групповые лимиты начнут действовать сразу после оплаты.',
      ].join('\n\n'),
      { reply_markup: subscriptionKeyboard(session.token, options) },
    );
    return;
  }

  const match = /^subscription:([A-Z]+):([a-z0-9]+)$/i.exec(data);
  if (!match) return;
  const plan = planFromValue(match[1].toUpperCase());
  if (!plan) {
    await ctx.answerCallbackQuery({ text: 'Неизвестный тариф' });
    return;
  }
  const session = await getPurchaseSession(match[2], ctx.from.id);
  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Ссылка устарела' });
    return;
  }
  if (
    session.termsAcceptedAt === null ||
    session.termsVersion !== paymentTermsVersion
  ) {
    await ctx.answerCallbackQuery({ text: 'Сначала примите условия' });
    return;
  }

  let order: Awaited<ReturnType<typeof createPaymentOrder>>;
  try {
    order = await createPaymentOrder({
      userId: ctx.from.id,
      plan,
      purchaseToken: session.token,
    });
  } catch (error) {
    if (error instanceof PurchaseValidationError) {
      await ctx.answerCallbackQuery({
        text:
          error.code === 'PLAN_DOWNGRADE'
            ? 'Этот тариф дешевле активной подписки'
            : 'Ссылка устарела. Начните покупку снова.',
      });
      return;
    }
    throw error;
  }
  await ctx.answerCallbackQuery();
  await ctx.replyWithInvoice(
    `Phoronis — ${getPlanTitle(plan)}`,
    formatInvoiceDescription({
      plan: order.plan,
      amount: order.amount,
      discountPercent: order.discountPercent,
      expiresAt: order.expiresAt,
    }),
    getInvoicePayload(order.id),
    'XTR',
    [{ label: getPlanTitle(plan), amount: order.amount }],
  );
}

export async function limitsController(ctx: BotContext): Promise<void> {
  if (!ctx.from || !ctx.chatId) return;
  const overview = await getQuotaOverview({
    userId: ctx.from.id,
    chatId: ctx.chatId,
    isGroup: isGroup(ctx),
  });
  const personal = overview.personal;
  const lines = [
    'Личные лимиты на сегодня:',
    `• Основные ответы: ${formatQuota(personal.PRIMARY_RESPONSE)}`,
    `• Изображения: ${formatQuota(personal.IMAGE)}`,
    `• Войсы: ${formatQuota(personal.VOICE)}`,
    `• Запоминание контекста: ${formatQuota(personal.ANALYSIS)}`,
  ];
  if (overview.chat) {
    lines.push(
      '',
      'Групповые лимиты для вас в этом чате:',
      `• Ответы: ${formatQuota(overview.chat.PRIMARY_RESPONSE)}`,
      `• Изображения: ${formatQuota(overview.chat.IMAGE)}`,
      `• Войсы: ${formatQuota(overview.chat.VOICE)}`,
      `• Запоминание контекста: ${formatQuota(overview.chat.ANALYSIS)}`,
    );
  }
  await ctx.reply(lines.join('\n'));
}

export async function subscriptionStatusController(
  ctx: BotContext,
): Promise<void> {
  if (!ctx.from) return;
  const subscription = await getActiveSubscription(ctx.from.id);
  if (!subscription) {
    await ctx.reply(
      'Активной подписки нет. Откройте /subscribe в группе, которой хотите подарить групповые лимиты.',
    );
    return;
  }
  await ctx.reply(
    `Активный тариф: ${getPlanTitle(subscription.plan)} до ${subscription.endsAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}.`,
  );
}

export async function termsController(ctx: BotContext): Promise<void> {
  await ctx.reply(paymentTermsText);
}

export async function paymentSupportController(ctx: BotContext): Promise<void> {
  await ctx.reply(
    `По вопросам оплаты и возврата напишите: ${paymentSupportContact}\n\nУкажите ваш Telegram username, дату платежа, сумму в Stars и приложите чек. Поддержка Telegram не обрабатывает покупки внутри Phoronis.`,
  );
}

export async function preCheckoutController(ctx: BotContext): Promise<void> {
  const query = ctx.preCheckoutQuery;
  if (!query) return;
  const order = await validatePaymentOrder({
    invoicePayload: query.invoice_payload,
    userId: query.from.id,
    currency: query.currency,
    amount: query.total_amount,
  });
  await ctx.answerPreCheckoutQuery(Boolean(order), {
    ...(order
      ? {}
      : { error_message: 'Счёт устарел. Откройте покупку ещё раз.' }),
  });
}

export async function successfulPaymentController(
  ctx: BotContext,
): Promise<void> {
  const payment = ctx.msg?.successful_payment;
  if (!payment || !ctx.from) return;
  const subscription = await activatePayment({
    invoicePayload: payment.invoice_payload,
    userId: ctx.from.id,
    currency: payment.currency,
    amount: payment.total_amount,
    chargeId: payment.telegram_payment_charge_id,
    buyer: {
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      username: ctx.from.username,
    },
  });
  if (!subscription?.activatedNow) return;
}

export async function refundedPaymentController(
  ctx: BotContext,
): Promise<void> {
  const payment = ctx.msg?.refunded_payment;
  if (!payment) return;
  await refundPayment(payment.telegram_payment_charge_id).catch((error) =>
    logger.error(
      { event: 'subscription.refund_revoke_failed', err: error },
      'Failed to revoke refunded subscription',
    ),
  );
}
