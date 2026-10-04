import {
  decisionReportJson,
  decisionReportOptions,
  formatDecisionReport,
} from '../domain/user/decision-report';

try {
  const options = decisionReportOptions(process.argv.slice(2));
  if (options.help) {
    console.log(
      'bun run jev:report -- --days 3 --limit 30 [--chat-id -100...] [--json]\nЖурнал хранится 7 дней. Команда читает БД, указанную в DATABASE_URL.',
    );
  } else {
    if (!process.env.DATABASE_URL)
      throw new Error('Для отчёта нужен DATABASE_URL.');
    const { prisma } = await import('../db');
    try {
      const { readDecisionReviewReportRepo } = await import(
        '../repositories/decision-review-repository'
      );
      const report = await readDecisionReviewReportRepo(options);
      console.log(
        options.json
          ? decisionReportJson(report)
          : formatDecisionReport(report),
      );
    } finally {
      await prisma.$disconnect();
    }
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Не удалось сформировать отчёт.',
  );
  process.exitCode = 1;
}
