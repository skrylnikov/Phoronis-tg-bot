import { z } from 'zod';
import { routerAIToken } from '../config';
import { logger } from '../logger';
import { currentUpdateAbortSignalWithTimeout } from '../update-signal';
import { decisionModelId } from './model-ids';

export type DecisionQuestion =
  | { type: 'noul'; instructions: string }
  | {
      type: 'choice';
      instructions: string;
      criteria: Record<string, string>;
    };

const probability = z.number().min(0).max(1);
const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
    confidence: probability,
  }),
]);
export type DecisionAnswer = z.infer<typeof answerSchema>;

const responseSchema = z.object({
  model: z.string().min(1).max(200),
  answers: z.record(z.string(), answerSchema),
});

export async function evaluateJev(
  state: object,
  questions: Record<string, DecisionQuestion>,
): Promise<{
  model: string;
  answers: Record<string, DecisionAnswer>;
  durationMs: number;
}> {
  if (Object.keys(questions).length === 0) {
    throw new Error('Jev requires at least one question');
  }
  const startedAt = performance.now();
  try {
    const response = await fetch('https://routerai.ru/api/v1/decisions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${routerAIToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: decisionModelId, state, questions }),
      signal: currentUpdateAbortSignalWithTimeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Jev request failed with status ${response.status}`);
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Jev returned an invalid response');
    const result = parsed.data;
    for (const [id, question] of Object.entries(questions)) {
      const answer = result.answers[id];
      if (!answer || answer.type !== question.type) {
        throw new Error('Jev returned missing or mismatched answers');
      }
      if (question.type === 'choice' && answer.type === 'choice') {
        const options = Object.keys(question.criteria);
        const values = Object.values(answer.probabilities);
        if (
          !options.includes(answer.choice) ||
          Object.keys(answer.probabilities).length !== options.length ||
          options.some((key) => answer.probabilities[key] === undefined) ||
          Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.02 ||
          answer.probabilities[answer.choice] < Math.max(...values)
        ) {
          throw new Error('Jev returned an invalid choice distribution');
        }
      }
    }
    const durationMs = Math.round(performance.now() - startedAt);
    logger.info(
      {
        event: 'jev.request_completed',
        model: result.model,
        questionCount: Object.keys(questions).length,
        durationMs,
      },
      'Jev evaluation completed',
    );
    return { ...result, durationMs };
  } catch (error) {
    logger.warn(
      {
        event: 'jev.request_failed',
        model: decisionModelId,
        questionCount: Object.keys(questions).length,
        durationMs: Math.round(performance.now() - startedAt),
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
      'Jev evaluation failed',
    );
    throw new Error('Jev evaluation unavailable', { cause: error });
  }
}
