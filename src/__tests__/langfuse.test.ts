import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  propagateAttributes: vi.fn(),
  startActiveObservation: vi.fn(),
}));

vi.mock('@langfuse/tracing', () => mocks);

import { withAiObservation } from '../ai/langfuse';

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
        activeObservation.update({ metadata: { latencyMs: 12 } });
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
