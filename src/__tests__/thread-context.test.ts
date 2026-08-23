import { describe, expect, it, vi } from 'vitest';

vi.mock('../ai/ai', () => ({ utilityModel: { modelId: 'utility-model' } }));

import {
  chooseChatGenerationRules,
  renderChatGenerationRules,
  serializeAiThreadEvents,
} from '../ai/thread-context';

describe('AI thread context serialization', () => {
  it('replays append-only events without inserting system messages', () => {
    const messages = serializeAiThreadEvents([
      {
        sequence: 1,
        eventKind: 'INITIAL_CONTEXT',
        payload: { users: ['Ио'] },
      },
      {
        sequence: 2,
        eventKind: 'RETRIEVAL',
        payload: { results: ['контекст'] },
      },
      {
        sequence: 3,
        eventKind: 'USER_MESSAGE',
        payload: { content: 'Первый вопрос' },
      },
      {
        sequence: 4,
        eventKind: 'ASSISTANT',
        payload: { content: 'Первый ответ' },
      },
      {
        sequence: 5,
        eventKind: 'CORRECTION',
        payload: { fact: 'Новое значение' },
      },
      {
        sequence: 6,
        eventKind: 'USER_MESSAGE',
        payload: { content: 'Второй вопрос' },
      },
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'user',
      'user',
      'assistant',
      'user',
      'user',
    ]);
    expect(messages[0]?.content).toContain('INITIAL_CONTEXT');
    expect(messages[3]?.content).toBe('Первый ответ');
    expect(messages.every((message) => message.role !== 'system')).toBe(true);
  });

  it('keeps only the latest segment after a cache boundary', () => {
    const messages = serializeAiThreadEvents([
      {
        sequence: 1,
        eventKind: 'USER_MESSAGE',
        payload: { content: 'Старый вопрос' },
      },
      {
        sequence: 2,
        eventKind: 'CACHE_BOUNDARY',
        payload: { snapshot: 'Актуальное состояние' },
      },
      {
        sequence: 3,
        eventKind: 'USER_MESSAGE',
        payload: { content: 'Новый вопрос' },
      },
    ]);

    expect(JSON.stringify(messages)).not.toContain('Старый вопрос');
    expect(JSON.stringify(messages)).toContain('Актуальное состояние');
    expect(JSON.stringify(messages)).toContain('Новый вопрос');
  });

  it('preserves deterministic thread rules and later correction precedence', () => {
    const rules = chooseChatGenerationRules(() => 0.05);
    expect(rules).toEqual({
      short: true,
      helpful: true,
      interests: true,
      username: true,
      funny: false,
    });
    expect(renderChatGenerationRules(rules)).toContain('- Отвечай кратко');
  });
});
