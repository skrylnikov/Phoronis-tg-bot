import { parseArgs } from 'node:util';
import type { readDecisionReviewReportRepo } from '../../repositories/decision-review-repository';

export function decisionReportOptions(args: string[]) {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--chat-id' && /^-\d+$/.test(args[index + 1] ?? '')) {
      normalized.push(`--chat-id=${args[++index]}`);
    } else normalized.push(arg);
  }
  const { values } = parseArgs({
    args: normalized,
    options: {
      days: { type: 'string', default: '3' },
      limit: { type: 'string', default: '30' },
      'chat-id': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const days = Number(values.days);
  const limit = Number(values.limit);
  if (
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > 7 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    (values['chat-id'] !== undefined && !/^-?\d+$/.test(values['chat-id']))
  ) {
    throw new Error(
      'Нужны --days от 1 до 7, --limit от 1 до 200 и целочисленный --chat-id.',
    );
  }
  return {
    days,
    limit,
    json: values.json,
    help: values.help,
    chatId:
      values['chat-id'] === undefined ? undefined : BigInt(values['chat-id']),
  };
}

export function decisionReportJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    2,
  );
}

export function formatDecisionReport(
  report: Awaited<ReturnType<typeof readDecisionReviewReportRepo>>,
): string {
  const lines = [
    `Проверки Jev: ${report.since.toISOString()} — ${report.until.toISOString()}`,
    `Записей решений: ${report.total}. Это число проверок, не число уникальных фактов и не точность модели.`,
    'Покрытие ограничено успешно записанным журналом. Ошибки записи ищите в jev.review_write_failed / jev.review_update_failed.',
  ];
  if (report.total === 0)
    return [...lines, 'За выбранный период данных нет.'].join('\n');
  lines.push(
    `Задержка оценки по записям: средняя ${Math.round(report.latency.averageMs ?? 0)} мс, максимум ${report.latency.maxMs ?? 0} мс. Пакетные проверки делят одну задержку.`,
  );
  lines.push('', 'Тип | Решение | Действие | Модель | Количество');
  for (const group of report.groups) {
    lines.push(
      `${group.kind} | ${group.outcome} | ${group.action} | ${group.actualModel ?? 'нет ответа'} | ${group._count}`,
    );
  }
  lines.push(
    '',
    `Примеры (${report.examples.length}; сначала отклонённые, неуверенные и незавершённые):`,
  );
  for (const example of report.examples) {
    lines.push(
      '',
      `[${example.id}] ${example.kind}: ${example.outcome} → ${example.action}`,
      `Источник: chat=${example.sourceChatId} message=${example.sourceMessageId} author=${example.source.authorId}; user=${example.userId}; run=${example.runId}`,
      `Кандидат: ${example.candidate}`,
      `Сообщение: ${example.source.text}`,
    );
    if (example.source.reply)
      lines.push(
        `Публичный reply (${example.source.reply.authorId}): ${example.source.reply.text}`,
      );
    if (example.comparison)
      lines.push(`Сравнение: ${decisionReportJson(example.comparison)}`);
    lines.push(
      `Оценки: ${decisionReportJson(example.scores)}; пороги: ${decisionReportJson(example.thresholds)}; правила: ${example.policyVersion}`,
    );
  }
  return lines.join('\n');
}
