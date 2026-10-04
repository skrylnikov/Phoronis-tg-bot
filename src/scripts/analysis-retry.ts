import {
  analysisRetryHelp,
  parseAnalysisRetryArgs,
} from '../application/analysis-retry';
import { analysisErrorCategory } from '../domain/user/analysis-stage';
import {
  chooseAnalysisReplies,
  filterAnalysisReplies,
  readAnalysisWindow,
} from '../domain/user/analysis-window';

async function main() {
  const args = parseAnalysisRetryArgs(process.argv.slice(2));
  if (args.help) {
    console.log(analysisRetryHelp);
    return;
  }
  const { prisma } = await import('../db');
  const { findFailedAnalysisJobsRepo, replayFailedAnalysisJobRepo } =
    await import('../repositories/background-job-repository');
  const { findMessagesRepo, findAnalysisSourcesRepo } = await import(
    '../repositories/message-repository'
  );
  try {
    const jobs = await findFailedAnalysisJobsRepo(args);
    const botIdText = process.env.TOKEN?.split(':')[0];
    const botId =
      botIdText && /^\d+$/u.test(botIdText) ? BigInt(botIdText) : 0n;
    const preview = [];
    for (const job of jobs) {
      const payload = job.payload as { userId?: unknown; chatId?: unknown };
      if (
        typeof payload.userId !== 'string' ||
        !/^\d+$/u.test(payload.userId)
      ) {
        preview.push({ id: job.id, invalidPayload: true });
        continue;
      }
      const window = readAnalysisWindow(job.payload);
      const cutoffAt = new Date(
        Math.min(
          window ? Date.parse(window.cutoffAt) : job.createdAt.getTime(),
          job.createdAt.getTime(),
        ),
      );
      const base = window
        ? await findAnalysisSourcesRepo({
            chatId: args.chatId,
            senderId: BigInt(payload.userId),
            cutoffAt,
            botId,
            ids: window.baseMessageIds.map(BigInt),
          })
        : await findMessagesRepo({
            chatId: args.chatId,
            senderId: BigInt(payload.userId),
            private: false,
            sentAt: { lte: cutoffAt },
          });
      const replies = await findAnalysisSourcesRepo({
        chatId: args.chatId,
        cutoffAt,
        botId,
        ...(window?.replyMessageIds
          ? { ids: window.replyMessageIds.map(BigInt) }
          : {
              replyToIds: base.map((m) => m.id),
              parentIds: base.flatMap((m) =>
                m.replyToMessageId === null ? [] : [m.replyToMessageId],
              ),
            }),
      });
      const selected = chooseAnalysisReplies(
        base,
        filterAnalysisReplies(base, replies),
      );
      preview.push({
        id: job.id,
        createdAt: job.createdAt,
        cutoffAt,
        userId: payload.userId,
        legacyApproximation: !window,
        baseCount: base.length,
        missingBaseCount: window
          ? window.baseMessageIds.length - base.length
          : null,
        replyCount: selected.replyMessageIds.length,
        repliesTruncated:
          selected.repliesTruncated || window?.repliesTruncated || false,
        botFilterApplied: botId !== 0n,
        previousAttempts: job.attempts,
        errorCategory: analysisErrorCategory(new Error(job.lastError ?? '')),
      });
    }
    console.log(
      JSON.stringify(
        {
          mode: args.apply ? 'apply' : 'dry-run',
          selected: jobs.length,
          preview,
        },
        null,
        2,
      ),
    );
    if (args.apply) {
      let replayed = 0;
      for (const job of jobs)
        if (
          !preview.find((p) => p.id === job.id)?.invalidPayload &&
          (await replayFailedAnalysisJobRepo(job))
        )
          replayed++;
      console.log(
        JSON.stringify({ replayed, skipped: jobs.length - replayed }),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error &&
      (error.message.startsWith('Invalid --') ||
        error.message.startsWith('--from'))
      ? error.message
      : 'Analysis retry failed; no further jobs applied',
  );
  process.exitCode = 1;
});
