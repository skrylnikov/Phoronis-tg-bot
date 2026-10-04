import { afterEach, describe, expect, it, vi } from 'vitest';
import { withUpdateAbortSignal } from '../update-signal';

vi.mock('../config', () => ({ routerAIToken: 'test-key' }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { evaluateJev } from '../ai/jev';

const questions = {
  supported: { type: 'noul' as const, instructions: 'Поддержан ли факт?' },
  relation: {
    type: 'choice' as const,
    instructions: 'Какое отношение?',
    criteria: { same: 'Дубликат', different: 'Различаются' },
  },
};
const validResponse = {
  model: 'typesafe/jev-1.13-snapshot',
  answers: {
    supported: { type: 'noul', noul: 0.95 },
    relation: {
      type: 'choice',
      choice: 'same',
      probabilities: { same: 0.95, different: 0.05 },
      confidence: 0.9,
    },
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('RouterAI Jev transport', () => {
  it('uses the decisions contract and validates both question types', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(validResponse));
    vi.stubGlobal('fetch', fetchMock);
    const result = await evaluateJev({ source: 'Я люблю Rust' }, questions);
    expect(result.model).toBe(validResponse.model);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://routerai.ru/api/v1/decisions');
    expect(JSON.parse(options.body)).toEqual({
      model: 'typesafe/jev-1.13',
      state: { source: 'Я люблю Rust' },
      questions,
    });
    expect(options.headers.authorization).toBe('Bearer test-key');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    { ...validResponse, answers: {} },
    {
      ...validResponse,
      answers: {
        ...validResponse.answers,
        supported: { type: 'noul', noul: 1.1 },
      },
    },
    {
      ...validResponse,
      answers: {
        ...validResponse.answers,
        supported: { type: 'noul', noul: '0.9' },
      },
    },
    {
      ...validResponse,
      answers: {
        ...validResponse.answers,
        relation: { ...validResponse.answers.relation, choice: 'invented' },
      },
    },
    {
      ...validResponse,
      answers: {
        ...validResponse.answers,
        relation: {
          ...validResponse.answers.relation,
          probabilities: { same: 0.95 },
        },
      },
    },
    {
      ...validResponse,
      answers: {
        ...validResponse.answers,
        relation: {
          ...validResponse.answers.relation,
          probabilities: { same: 0.2, different: 0.8 },
        },
      },
    },
  ])(
    'rejects malformed or incomplete output without exposing it',
    async (payload) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
      await expect(evaluateJev({}, questions)).rejects.toThrow(
        'Jev evaluation unavailable',
      );
    },
  );

  it('does not expose HTTP response bodies or network exception payloads', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('private text and secret', { status: 429 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(evaluateJev({}, questions)).rejects.toThrow(
      'Jev evaluation unavailable',
    );
    fetchMock.mockRejectedValue(new Error('private text and secret'));
    await expect(evaluateJev({}, questions)).rejects.toThrow(
      'Jev evaluation unavailable',
    );
  });

  it('combines the update cancellation with its deadline', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        options.signal.throwIfAborted();
      }),
    );
    await expect(
      withUpdateAbortSignal(controller.signal, () =>
        evaluateJev({}, questions),
      ),
    ).rejects.toThrow('Jev evaluation unavailable');
  });
});
