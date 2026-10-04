import { decisionModelId } from '../../ai/model-ids';
import type { Prisma } from '../../generated/prisma/client';
import { logger } from '../../logger';
import {
  createDecisionReviewRepo,
  finishDecisionReviewRepo,
} from '../../repositories/decision-review-repository';
import { throwIfUpdateAborted } from '../../update-signal';

export const decisionPolicyVersion = 2;
export const decisionThresholds = { accept: 0.8, reject: 0.1 };

export function probabilityOutcome(probability: number) {
  return probability >= decisionThresholds.accept
    ? 'accepted'
    : probability <= decisionThresholds.reject
      ? 'rejected'
      : 'uncertain';
}

export interface ReviewInput {
  runId: string;
  kind: 'fact_source' | 'fact_relation' | 'alias';
  userId: bigint;
  sourceChatId: bigint;
  sourceMessageId: bigint;
  candidate: string;
  candidateType?: string;
  actualModel?: string;
  scores: Prisma.InputJsonObject;
  comparison?: Prisma.InputJsonObject;
  outcome: 'accepted' | 'rejected' | 'uncertain' | 'error';
  action: string;
  durationMs: number;
}

export async function recordDecisionReview(
  input: ReviewInput,
  botId?: bigint,
): Promise<string | undefined> {
  throwIfUpdateAborted();
  let reviewId: string | undefined;
  try {
    reviewId = await createDecisionReviewRepo(
      {
        ...input,
        policyVersion: decisionPolicyVersion,
        requestedModel: decisionModelId,
        thresholds: decisionThresholds,
      },
      botId,
    );
  } catch {
    logger.warn(
      {
        event: 'jev.review_write_failed',
        runId: input.runId,
        kind: input.kind,
      },
      'Decision review could not be stored',
    );
  }
  logger.info(
    {
      event: 'jev.decision',
      reviewId,
      runId: input.runId,
      kind: input.kind,
      userId: String(input.userId),
      chatId: String(input.sourceChatId),
      messageId: String(input.sourceMessageId),
      model: input.actualModel ?? decisionModelId,
      policyVersion: decisionPolicyVersion,
      scores: input.scores,
      thresholds: decisionThresholds,
      outcome: input.outcome,
      action: input.action,
      durationMs: input.durationMs,
      reviewStored: reviewId !== undefined,
    },
    'Jev candidate decision',
  );
  return reviewId;
}

export async function finishDecisionReview(
  reviewId: string | undefined,
  action: string,
  resultId?: bigint,
): Promise<void> {
  if (!reviewId) return;
  throwIfUpdateAborted();
  try {
    await finishDecisionReviewRepo(reviewId, action, resultId?.toString());
  } catch {
    logger.warn(
      { event: 'jev.review_update_failed', reviewId },
      'Decision review action could not be stored',
    );
  }
  logger.info(
    { event: 'jev.action', reviewId, action, resultId: resultId?.toString() },
    'Jev decision applied',
  );
}
