import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const { createWebTools, streamText } = vi.hoisted(() => ({
  createWebTools: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('ai', () => ({
  dynamicTool: vi.fn((definition: unknown) => definition),
  stepCountIs: vi.fn(),
  streamText,
}));
vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock('../ai/ai', () => ({ chatModel: {} }));
vi.mock('../ai/tools', () => ({
  canUseChatHistoryTool: vi.fn(
    (ctx: BotContext | undefined) =>
      ctx?.chat?.type === 'private' ||
      ctx?.chat?.type === 'group' ||
      ctx?.chat?.type === 'supergroup',
  ),
  createChatHistoryTool: vi.fn(() => ({ execute: vi.fn() })),
  createUserInfoTool: vi.fn(() => ({})),
  createWebTools,
  weatherTool: {},
  wikipediaTool: {},
}));
vi.mock('../ai/tools/memory', () => ({
  createClearMemoryTool: vi.fn(() => ({})),
  createMemoryTool: vi.fn(() => ({})),
}));

import { chatGeneration } from '../ai/chat-generation';

function createContext(
  text: string,
  type: 'private' | 'group' | 'supergroup' = 'supergroup',
  repliedText?: string,
): BotContext {
  return {
    chat: { id: -100, type },
    chatId: -100,
    from: { id: 123 },
    me: { id: 456, username: 'io' },
    msg: {
      message_id: 200,
      date: Math.floor(Date.UTC(2026, 6, 26, 10) / 1000),
      text,
      reply_to_message: repliedText ? { text: repliedText } : undefined,
    },
  } as unknown as BotContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  createWebTools.mockReturnValue(undefined);
  streamText.mockImplementation(() => ({
    textStream: (async function* () {})(),
    text: Promise.resolve('Готово'),
  }));
});

describe('chat history tool selection', () => {
  it('records safe generation metrics without raw prompt telemetry', async () => {
    const trace = { update: vi.fn() };

    await chatGeneration(
      [
        { role: 'system', content: 'PRIVATE PROMPT' },
        { role: 'user', content: 'PRIVATE CONTEXT' },
      ],
      trace as never,
    );

    expect(trace.update).toHaveBeenCalledWith({
      metadata: expect.objectContaining({
        inputMessageCount: 2,
        providerCacheRead: 'unavailable',
        providerCacheWrite: 'unavailable',
      }),
    });
    expect(trace.update.mock.calls[0]?.[0]).not.toHaveProperty('input');
    expect(trace.update.mock.calls[0]?.[0]).not.toHaveProperty('output');
  });

  it('requires history search before answering a history question', async () => {
    await chatGeneration(
      [{ role: 'user', content: 'Ио, когда мы обсуждали фильмы?' }],
      undefined,
      createContext('Ио, когда мы обсуждали фильмы?'),
      undefined,
      { allowChatHistory: true },
    );

    const options = streamText.mock.calls[0]?.[0] as {
      tools: Record<string, unknown>;
      prepareStep?: (input: { stepNumber: number }) => unknown;
    };
    expect(options.tools).toHaveProperty('search_chat_history');
    expect(options.prepareStep?.({ stepNumber: 0 })).toEqual({
      toolChoice: {
        type: 'tool',
        toolName: 'search_chat_history',
      },
    });
    expect(options.prepareStep?.({ stepNumber: 1 })).toEqual({
      toolChoice: 'none',
    });
  });

  it('requires history search for a question about the chat opinion', async () => {
    await chatGeneration(
      [{ role: 'user', content: 'Ио, что чат думает про раст?' }],
      undefined,
      createContext('Ио, что чат думает про раст?'),
      undefined,
      { allowChatHistory: true },
    );

    const options = streamText.mock.calls[0]?.[0] as {
      prepareStep?: (input: { stepNumber: number }) => unknown;
    };
    expect(options.prepareStep?.({ stepNumber: 0 })).toEqual({
      toolChoice: {
        type: 'tool',
        toolName: 'search_chat_history',
      },
    });
  });

  it('keeps automatic tool selection for ordinary group questions', async () => {
    await chatGeneration(
      [{ role: 'user', content: 'Посоветуй хороший фильм' }],
      undefined,
      createContext('Посоветуй хороший фильм'),
      undefined,
      { allowChatHistory: true },
    );

    const options = streamText.mock.calls[0]?.[0] as {
      tools: Record<string, unknown>;
      prepareStep?: unknown;
    };
    expect(options.prepareStep).toBeUndefined();
    expect(options.tools).not.toHaveProperty('read_web_page');
  });

  it('registers web tools in ordinary and read-only modes', async () => {
    const webTools = { read_web_page: {}, search_web: {} };
    createWebTools.mockReturnValue(webTools);

    await chatGeneration(
      [{ role: 'user', content: 'прочитай https://example.test' }],
      undefined,
      createContext('прочитай https://example.test'),
    );
    const writable = streamText.mock.calls[0]?.[0] as {
      tools: Record<string, unknown>;
    };
    expect(writable.tools).toEqual(expect.objectContaining(webTools));
    expect(writable.tools).toHaveProperty('set_greeting');

    await chatGeneration(
      [{ role: 'user', content: 'прочитай https://example.test' }],
      undefined,
      createContext('прочитай https://example.test'),
      undefined,
      { readOnlyTools: true },
    );
    const readOnly = streamText.mock.calls[1]?.[0] as {
      tools: Record<string, unknown>;
    };
    expect(readOnly.tools).toEqual(expect.objectContaining(webTools));
    expect(readOnly.tools).not.toHaveProperty('set_greeting');
    expect(readOnly.tools).not.toHaveProperty('save_memory');
    expect(readOnly.tools).not.toHaveProperty('clear_memory');
  });

  it('requires history search for an explicit chat-search follow-up', async () => {
    await chatGeneration(
      [{ role: 'user', content: 'поищи по чату' }],
      undefined,
      createContext(
        'поищи по чату',
        'supergroup',
        'Раст тут любят как материал.',
      ),
      undefined,
      { allowChatHistory: true },
    );

    const options = streamText.mock.calls[0]?.[0] as {
      prepareStep?: (input: { stepNumber: number }) => unknown;
    };
    expect(options.prepareStep?.({ stepNumber: 0 })).toEqual({
      toolChoice: {
        type: 'tool',
        toolName: 'search_chat_history',
      },
    });
  });

  it('exposes history search in private chats', async () => {
    await chatGeneration(
      [{ role: 'user', content: 'Когда мы обсуждали фильмы?' }],
      undefined,
      createContext('Когда мы обсуждали фильмы?', 'private'),
      undefined,
      { allowChatHistory: true },
    );

    const options = streamText.mock.calls[0]?.[0] as {
      tools: Record<string, unknown>;
      prepareStep?: unknown;
    };
    expect(options.tools).toHaveProperty('search_chat_history');
    expect(options.prepareStep).toBeDefined();
  });
});
