import { expect, it, vi } from 'vitest';
import {
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
  withUpdateAbortSignal,
} from '../update-signal';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../logger', () => ({ logger: log }));

import {
  analysisStage,
  withAnalysisAttempt,
} from '../domain/user/analysis-stage';

it.each([
  'extraction',
  'verification',
  'fact_relation',
  'embedding',
  'persistence',
])('bounds %s and logs only technical context', async (stage) => {
  await expect(
    withAnalysisAttempt({ jobId: 'job', attempt: 2, runId: 'run' }, () =>
      analysisStage(stage, async () => {
        throw new DOMException('SENTINEL SECRET source prompt', 'TimeoutError');
      }),
    ),
  ).rejects.toThrow(`analysis:${stage}:timeout`);
  const serialized = JSON.stringify(log.warn.mock.calls);
  expect(serialized).not.toContain('SENTINEL');
  expect(log.warn).toHaveBeenLastCalledWith(
    expect.objectContaining({
      stage,
      jobId: 'job',
      attempt: 2,
      runId: 'run',
      category: 'timeout',
      durationMs: expect.any(Number),
    }),
    expect.any(String),
  );
});
it('propagates abort into external operations and prevents later writes', async () => {
  const controller = new AbortController();
  let writes = 0;
  const promise = withUpdateAbortSignal(controller.signal, () =>
    analysisStage('extraction', async () => {
      const signal = currentUpdateAbortSignal();
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      throwIfUpdateAborted();
      writes++;
    }),
  );
  controller.abort(new DOMException('stopped', 'AbortError'));
  await expect(promise).rejects.toThrow();
  expect(writes).toBe(0);
  await expect(
    analysisStage('embedding', () => new Promise(() => {}), 5),
  ).rejects.toThrow('analysis:embedding:timeout');
});
