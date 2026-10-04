import { bot } from '../bot';
import { releaseQuota, reserveQuota } from '../domain/quota-service';
import {
  analysisStage,
  withAnalysisAttempt,
} from '../domain/user/analysis-stage';
import {
  attachAnalysisParents,
  chooseAnalysisReplies,
  filterAnalysisReplies,
  readAnalysisWindow,
} from '../domain/user/analysis-window';
import { analyzeUserMetaInfo } from '../domain/user/fact-analyzer';
import { logger } from '../logger';
import {
  type ClaimedBackgroundJob,
  enqueueBackgroundJobRepo,
  freezeAnalysisWindowRepo,
} from '../repositories/background-job-repository';
import {
  countMessagesRepo,
  findAnalysisSourcesRepo,
  findMessagesRepo,
} from '../repositories/message-repository';
import {
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
  withUpdateAbortSignal,
} from '../update-signal';

type AnalysisInput = { userId: number; chatId: number; isGroup: boolean };
export async function scheduleUserMessageAnalysis(
  input: AnalysisInput,
): Promise<void> {
  const where = {
    chatId: BigInt(input.chatId),
    senderId: BigInt(input.userId),
    private: false,
  };
  const messageCount = await countMessagesRepo(where);
  if (!messageCount || messageCount % 30 !== 0) return;
  const createdAt = new Date();
  const messages = await findMessagesRepo({
    ...where,
    sentAt: { lte: createdAt },
  });
  throwIfUpdateAborted();
  await enqueueBackgroundJobRepo({
    type: 'USER_MESSAGE_ANALYSIS',
    dedupeKey: `user-analysis:${input.chatId}:${input.userId}:${messageCount}`,
    createdAt,
    payload: {
      userId: String(input.userId),
      chatId: String(input.chatId),
      isGroup: input.isGroup,
      windowVersion: 1,
      cutoffAt: createdAt.toISOString(),
      baseMessageIds: messages.map((m) => String(m.id)),
    },
  });
}
export function nextAnalysisQuotaDay(now = new Date()) {
  const shifted = new Date(now.getTime() + 3 * 3_600_000);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate() + 1,
    ) -
      3 * 3_600_000,
  );
}
export async function analyzeUserMessagesForUser(
  input: AnalysisInput,
  job: ClaimedBackgroundJob,
) {
  const parent = currentUpdateAbortSignal();
  const signal = AbortSignal.any([
    ...(parent ? [parent] : []),
    AbortSignal.timeout(180_000),
  ]);
  return withAnalysisAttempt(
    { jobId: job.id, attempt: job.attempts, runId: crypto.randomUUID() },
    () =>
      withUpdateAbortSignal(signal, async () => {
        const chatId = BigInt(input.chatId),
          userId = BigInt(input.userId),
          botId = BigInt(bot.botInfo.id);
        const prepared = await analysisStage('window', async () => {
          let window = readAnalysisWindow(job.payload);
          const payload = job.payload as Record<
            string,
            import('../generated/prisma/client').Prisma.InputJsonValue
          >;
          if (!window) {
            const base = await findMessagesRepo({
              chatId,
              senderId: userId,
              private: false,
              sentAt: { lte: job.createdAt },
            });
            window = {
              windowVersion: 1,
              cutoffAt: job.createdAt.toISOString(),
              baseMessageIds: base.map((m) => String(m.id)),
            };
          }
          const cutoffAt = new Date(
            Math.min(Date.parse(window.cutoffAt), job.createdAt.getTime()),
          );
          const base = await findAnalysisSourcesRepo({
            chatId,
            senderId: userId,
            botId,
            cutoffAt,
            ids: window.baseMessageIds.map(BigInt),
          });
          if (window.replyMessageIds === undefined) {
            const candidates = base.length
              ? await findAnalysisSourcesRepo({
                  chatId,
                  botId,
                  cutoffAt,
                  replyToIds: base.map((m) => m.id),
                  parentIds: base.flatMap((m) =>
                    m.replyToMessageId === null ? [] : [m.replyToMessageId],
                  ),
                })
              : [];
            window = { ...window, ...chooseAnalysisReplies(base, candidates) };
            throwIfUpdateAborted();
            await freezeAnalysisWindowRepo(job.id, job.workerId, {
              ...payload,
              ...window,
            });
          }
          const replies = await findAnalysisSourcesRepo({
            chatId,
            botId,
            cutoffAt,
            ids: (window.replyMessageIds ?? []).map(BigInt),
          });
          const baseIds = new Set(base.map((m) => m.id));
          const related = filterAnalysisReplies(base, replies);
          logger.info(
            {
              event: 'user_analysis.window_prepared',
              jobId: job.id,
              baseCount: base.length,
              missingBaseCount: window.baseMessageIds.length - base.length,
              replyCount: related.length,
              repliesTruncated: window.repliesTruncated ?? false,
            },
            'Analysis window prepared',
          );
          const sources = attachAnalysisParents(base, related);
          return { base: sources.filter((m) => baseIds.has(m.id)), sources };
        });
        if (!prepared.base.length) return { outcome: 'skipped_no_sources' };
        throwIfUpdateAborted();
        const reservation = await reserveQuota({ ...input, kind: 'ANALYSIS' });
        if (!reservation.allowed)
          return {
            outcome: 'quota_deferred',
            deferUntil: nextAnalysisQuotaDay(),
          };
        try {
          throwIfUpdateAborted();
          await analyzeUserMetaInfo(
            userId,
            prepared.base,
            botId,
            prepared.sources,
          );
          return { outcome: 'analyzed' };
        } catch (error) {
          await releaseQuota(reservation);
          throw error;
        }
      }),
  );
}
