import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  get: vi.fn(),
  append: vi.fn(),
  updateBoundary: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: mocks.generateText,
}));
vi.mock('../ai/ai', () => ({ utilityModel: { modelId: 'utility-model' } }));
vi.mock('../repositories/ai-thread-context-repository', () => ({
  ensureAiThreadContextRepo: mocks.ensure,
  getAiThreadContextRepo: mocks.get,
  appendAiThreadEventsRepo: mocks.append,
  updateAiThreadCacheBoundaryRepo: mocks.updateBoundary,
}));

import { buildAiThreadContext } from '../ai/thread-context';

describe('AI thread context builder', () => {
  const events: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    mocks.ensure.mockResolvedValue({
      id: 'thread-1',
      rules: 'persisted rules',
      cacheBoundary: 0,
    });
    mocks.generateText.mockResolvedValue({ text: 'Сводка диалога' });
    mocks.get.mockImplementation(async () => ({
      cacheBoundary: 0,
      events: events.map((event, index) => ({ ...event, sequence: index + 1 })),
    }));
    mocks.append.mockImplementation(async (_threadId, pending) => {
      events.push(...pending);
      return pending;
    });
  });

  it('persists rules once and replays the same prefix after a restart', async () => {
    const first = await buildAiThreadContext({
      threadId: 'thread-1',
      chatId: 1n,
      rootMessageId: 10n,
      turnId: 'turn-1',
      rules: 'new rules that must not replace the snapshot',
      userContext: {
        users: [{ id: '42', metaInfo: { interests: ['старый факт'] } }],
      },
      retrievalContext: { results: ['first'] },
      time: '23.08.2026 10:00:00',
      currentUserMessage: { role: 'user', content: 'Первый вопрос' },
      messageId: 10n,
    });
    const second = await buildAiThreadContext({
      threadId: 'thread-1',
      chatId: 1n,
      rootMessageId: 10n,
      turnId: 'turn-2',
      rules: 'different regenerated rules',
      userContext: {
        users: [{ id: '42', metaInfo: { interests: ['старый факт'] } }],
      },
      retrievalContext: { results: ['second'] },
      time: '23.08.2026 10:01:00',
      currentUserMessage: { role: 'user', content: 'Второй вопрос' },
      messageId: 12n,
    });

    expect(mocks.ensure).toHaveBeenCalledTimes(2);
    expect(first.instructions).toContain('persisted rules');
    expect(second.instructions).toBe(first.instructions);
    expect(second.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Второй вопрос',
    });
    expect(
      events.filter((event) => event.eventKind === 'INITIAL_CONTEXT'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventKind === 'USER_MESSAGE'),
    ).toHaveLength(2);

    await buildAiThreadContext({
      threadId: 'thread-1',
      chatId: 1n,
      rootMessageId: 10n,
      turnId: 'turn-3',
      rules: 'different regenerated rules',
      userContext: {
        users: [{ id: '42', metaInfo: { interests: ['новый факт'] } }],
      },
      time: '23.08.2026 10:02:00',
      currentUserMessage: { role: 'user', content: 'Третий вопрос' },
      messageId: 13n,
    });
    expect(events.some((event) => event.eventKind === 'CORRECTION')).toBe(true);
  });

  it('creates an observable boundary when the append-only segment nears the limit', async () => {
    await buildAiThreadContext({
      threadId: 'thread-1',
      chatId: 1n,
      rootMessageId: 10n,
      turnId: 'long-turn',
      rules: 'persisted rules',
      userContext: { users: [] },
      time: '23.08.2026 10:00:00',
      currentUserMessage: { role: 'user', content: 'x'.repeat(50_000) },
      messageId: 10n,
    });

    expect(mocks.updateBoundary).toHaveBeenCalledWith('thread-1', 1);
    expect(events.some((event) => event.eventKind === 'CACHE_BOUNDARY')).toBe(
      true,
    );
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        eventKind: 'CACHE_BOUNDARY',
        payload: expect.objectContaining({
          summary: 'Сводка диалога',
          userContexts: [{ event: 'INITIAL_CONTEXT', data: { users: [] } }],
        }),
      }),
    );
  });

  it('summarizes dialogue and preserves every user-context snapshot', async () => {
    await buildAiThreadContext({
      threadId: 'thread-1',
      chatId: 1n,
      rootMessageId: 10n,
      turnId: 'turn-1',
      rules: 'persisted rules',
      userContext: { users: [{ id: '1', metaInfo: { notes: ['старое'] } }] },
      time: '23.08.2026 10:00:00',
      currentUserMessage: { role: 'user', content: 'Начало разговора' },
      messageId: 10n,
    });
    events.push({
      eventKind: 'ASSISTANT',
      payload: { content: 'Ответ в начале разговора' },
    });

    const result = await buildAiThreadContext({
      threadId: 'thread-1',
      chatId: 1n,
      rootMessageId: 10n,
      turnId: 'turn-2',
      rules: 'persisted rules',
      userContext: { users: [{ id: '1', metaInfo: { notes: ['новое'] } }] },
      time: '23.08.2026 10:01:00',
      currentUserMessage: { role: 'user', content: 'x'.repeat(50_000) },
      messageId: 12n,
    });

    const boundary = events.find(
      (event) => event.eventKind === 'CACHE_BOUNDARY',
    );
    expect(boundary?.payload).toMatchObject({
      summary: 'Сводка диалога',
      userContexts: [
        {
          event: 'INITIAL_CONTEXT',
          data: { users: [{ id: '1', metaInfo: { notes: ['старое'] } }] },
        },
        {
          event: 'CORRECTION',
          data: { users: [{ id: '1', metaInfo: { notes: ['новое'] } }] },
        },
      ],
    });
    expect(JSON.stringify(mocks.generateText.mock.calls[0]?.[0])).toContain(
      'Ответ в начале разговора',
    );
    expect(JSON.stringify(result.messages)).toContain('Сводка диалога');
    expect(result.messages.at(-1)?.content).toBe('x'.repeat(50_000));
    expect(JSON.stringify(result.messages)).not.toContain(
      'Ответ в начале разговора',
    );
  });

  it('keeps the full context when LLM compaction fails', async () => {
    mocks.generateText.mockRejectedValueOnce(new Error('temporary failure'));

    const result = await buildAiThreadContext({
      threadId: 'thread-1',
      chatId: 1n,
      rootMessageId: 10n,
      turnId: 'failed-compaction',
      rules: 'persisted rules',
      userContext: { users: [] },
      time: '23.08.2026 10:00:00',
      currentUserMessage: { role: 'user', content: 'x'.repeat(50_000) },
      messageId: 10n,
    });

    expect(mocks.updateBoundary).not.toHaveBeenCalled();
    expect(events.some((event) => event.eventKind === 'CACHE_BOUNDARY')).toBe(
      false,
    );
    expect(JSON.stringify(result.messages)).toContain('x'.repeat(50_000));
  });

  it('uses the same first, second and long-turn contract for guest threads', async () => {
    events.length = 0;
    await buildAiThreadContext({
      threadId: 'guest-query-1',
      chatId: 1n,
      turnId: 'guest-turn-1',
      rules: 'guest rules',
      userContext: { users: [] },
      time: '23.08.2026 10:00:00',
      currentUserMessage: { role: 'user', content: 'Guest first' },
    });
    await buildAiThreadContext({
      threadId: 'guest-query-1',
      chatId: 1n,
      turnId: 'guest-turn-2',
      rules: 'guest rules regenerated',
      userContext: { users: [] },
      time: '23.08.2026 10:01:00',
      currentUserMessage: { role: 'user', content: 'Guest second' },
    });

    expect(
      events.filter((event) => event.eventKind === 'INITIAL_CONTEXT'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventKind === 'USER_MESSAGE'),
    ).toHaveLength(2);
    expect(events.some((event) => event.eventKind === 'TURN_CONTEXT')).toBe(
      true,
    );
  });
});
