import {
  getPersonalDailyLimits,
  planDetails,
  type QuotaKind,
} from './quota-service';
import {
  paymentTermsVersion,
  type SubscriptionPlan,
} from './subscription-rules';
import { getPlanTitle, type PurchaseOption } from './subscriptions';

function formatLimit(value: number): string {
  return value === Infinity ? 'безлимит' : String(value);
}

function formatQuotaList(details: Record<QuotaKind, number>): string[] {
  return [
    `• Основные ответы: ${formatLimit(details.PRIMARY_RESPONSE)}`,
    `• Изображения: ${formatLimit(details.IMAGE)}`,
    `• Голосовые: ${formatLimit(details.VOICE)}`,
    `• Анализ контекста: ${formatLimit(details.ANALYSIS)}`,
  ];
}

export function formatPlanPrice(input: {
  baseAmount: number;
  amount: number;
  discountPercent: number;
}): string[] {
  const lines = [`Обычная цена: ${input.baseAmount} ⭐`];
  if (input.discountPercent > 0) {
    lines.push(`Цена со скидкой ${input.discountPercent}%: ${input.amount} ⭐`);
  } else {
    lines.push(`Цена: ${input.amount} ⭐`);
  }
  return lines;
}

export function formatPaymentTerms(): string {
  return `Условия подписки Phoronis

• Это разовая покупка за Telegram Stars без автоматического продления.
• Личные лимиты выбранного тарифа являются итоговыми и заменяют бесплатные дневные лимиты. Групповой тариф добавляет групповые лимиты каждому участнику выбранной группы.
• Активные подписки, оформленные для одной группы, суммируются. Каждый участник получает независимую групповую квоту и не расходует квоту других участников; сначала расходуется групповая квота, затем личная.
• Дни новой покупки добавляются после уже оплаченного срока. Лимиты одновременно активных покупок суммируются и обновляются ежедневно по московскому времени.
• Пока действует подписка, можно купить такой же или более дорогой тариф. Более дешёвый тариф станет доступен после её окончания.
• Неиспользованные дневные лимиты не переносятся и не обмениваются на деньги или Stars.
• Ответы создаются ИИ и могут содержать ошибки; важную информацию необходимо проверять самостоятельно.
• При возврате соответствующие дни и лимиты отзываются. По вопросам оплаты используйте /paysupport.

Нажимая «Принимаю условия», вы подтверждаете согласие с этими условиями. Версия: ${paymentTermsVersion}.`;
}

export function formatSubscriptionCatalog(
  options: readonly PurchaseOption[],
): string {
  const cards = options.map((option) => {
    const details = planDetails[option.plan];
    const personalLimits = getPersonalDailyLimits([{ plan: option.plan }]);
    return [
      `«${getPlanTitle(option.plan)}»`,
      ...formatPlanPrice({
        baseAmount: details.amount,
        amount: option.amount,
        discountPercent: option.actualDiscount,
      }),
      'Личные лимиты в день:',
      ...formatQuotaList(personalLimits),
      'Групповые лимиты для каждого участника в день:',
      ...formatQuotaList(details.chat),
    ].join('\n');
  });

  return [
    'Тарифы Phoronis',
    'Личный тариф заменяет бесплатные лимиты. Подписки одной группы складываются, а её групповой лимит получает каждый участник отдельно.',
    'Все лимиты обновляются ежедневно в 00:00 МСК. «Безлимит» относится только к личному анализу контекста.',
    '',
    cards.join('\n\n'),
  ].join('\n');
}

export function formatInvoiceDescription(input: {
  plan: SubscriptionPlan;
  amount: number;
  discountPercent: number;
  expiresAt: Date;
}): string {
  const details = planDetails[input.plan];
  return [
    'Личные лимиты и групповые лимиты для каждого участника выбранного чата.',
    ...formatPlanPrice({
      baseAmount: details.amount,
      amount: input.amount,
      discountPercent: input.discountPercent,
    }),
    `Счёт действителен до ${input.expiresAt.toLocaleTimeString('ru-RU', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
    })} МСК.`,
  ].join('\n');
}
