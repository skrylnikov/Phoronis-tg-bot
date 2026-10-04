import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  propagateAttributes: vi.fn(),
  startActiveObservation: vi.fn(),
}));

vi.mock('@langfuse/tracing', () => mocks);
vi.mock('../logger', () => ({ logger: { warn: vi.fn() } }));

import { withAiObservation } from '../ai/langfuse';
import { tracePolicy } from '../ai/trace-data';

describe('AI Langfuse observation helper', () => {
  it('propagates correlation and only safe bounded metadata', async () => {
    const observation = { update: vi.fn() };
    mocks.startActiveObservation.mockImplementation(async (_name, callback) =>
      callback(observation),
    );
    mocks.propagateAttributes.mockImplementation(
      async (_attributes, callback) => callback(),
    );

    await withAiObservation(
      'chat-generation',
      {
        sessionId: 'session-1',
        userId: '123',
        metadata: {
          threadId: 'thread-1',
          inputMessageCount: 4,
          userName: 'private name',
          memory: 'private memory',
          retrievalContext: 'private retrieval result',
          rawMessages: '[{"role":"user","content":"private"}]',
          secretKey: 'sk-secret',
          apiKey: 'secret-token',
          prompt: 'PRIVATE PROMPT',
          longValue: 'x'.repeat(300),
        },
      },
      async (activeObservation) => {
        activeObservation?.update({ metadata: { latencyMs: 12 } });
        return 'ok';
      },
    );

    expect(mocks.startActiveObservation).toHaveBeenCalledWith(
      'chat-generation',
      expect.any(Function),
    );
    expect(mocks.propagateAttributes).toHaveBeenCalledWith(
      {
        sessionId: 'session-1',
        userId: '123',
        metadata: { threadId: 'thread-1', inputMessageCount: '4' },
      },
      expect.any(Function),
    );
    expect(observation.update).toHaveBeenCalledWith({
      metadata: { latencyMs: 12 },
    });
  });
});

describe('observation failure isolation', () => {
  it('continues once when creation fails', async () => {
    mocks.startActiveObservation.mockImplementation(() => {
      throw new Error('creation failed');
    });
    const run = vi.fn(async () => 'answer');
    expect(await withAiObservation('chat-generation', {}, run)).toBe('answer');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('preserves the original AI error without repeating work', async () => {
    mocks.startActiveObservation.mockImplementation(async (_name, callback) =>
      callback({}),
    );
    const error = new Error('provider failure');
    const run = vi.fn(async () => {
      throw error;
    });
    await expect(withAiObservation('chat-generation', {}, run)).rejects.toBe(
      error,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('isolates concurrent public and private policies', async () => {
    mocks.startActiveObservation.mockImplementation(async (_name, callback) =>
      callback({}),
    );
    const results = await Promise.all(
      [false, true].map((privateMode) =>
        withAiObservation('guest-generation', { privateMode }, async () => {
          await new Promise((resolve) =>
            setTimeout(resolve, privateMode ? 1 : 5),
          );
          return tracePolicy.getStore()?.privateMode;
        }),
      ),
    );
    expect(results).toEqual([false, true]);
    expect(tracePolicy.getStore()).toBeUndefined();
  });
});
