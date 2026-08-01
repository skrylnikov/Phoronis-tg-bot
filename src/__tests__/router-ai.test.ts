import { generateText, Output, stepCountIs, streamText, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../config', () => ({
  routerAIToken: 'test-routerai-token',
}));

import { chatModel, liteChatModel, utilityModel } from '../ai/ai';
import { splitSystemMessages } from '../ai/prompt';

interface RequestBody {
  model?: string;
  messages?: Array<{
    role?: string;
    content?: string | Array<{ type?: string; image_url?: { url?: string } }>;
  }>;
  response_format?: { type?: string };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

function streamResponse(chunks: unknown[]): Response {
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function chatChunk(
  delta: Record<string, unknown>,
  finishReason: 'stop' | 'tool_calls' | null,
) {
  return {
    id: 'chatcmpl-stream-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function chatResponse(
  content: string | null,
  finishReason: 'stop' | 'tool_calls',
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>,
) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, tool_calls: toolCalls },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RouterAI models', () => {
  it('uses GPT-5.6 Luna for the paid-quota fallback', async () => {
    let requestBody: RequestBody = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as RequestBody;
        return jsonResponse(chatResponse('fallback', 'stop'));
      }),
    );

    await generateText({ model: liteChatModel, prompt: 'fallback' });

    expect(requestBody.model).toBe('openai/gpt-5.6-luna');
  });

  it('streams text after completing a tool call', async () => {
    const requestBodies: RequestBody[] = [];
    const responses = [
      streamResponse([
        chatChunk(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call-stream',
                type: 'function',
                function: {
                  name: 'lookup',
                  arguments: '{"value":"test"}',
                },
              },
            ],
          },
          null,
        ),
        chatChunk({}, 'tool_calls'),
      ]),
      streamResponse([
        chatChunk({ role: 'assistant', content: 'го' }, null),
        chatChunk({ content: 'тово' }, null),
        chatChunk({}, 'stop'),
      ]),
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as RequestBody);
        const response = responses.shift();
        if (!response) {
          throw new Error('Unexpected RouterAI request');
        }
        return response;
      }),
    );

    const result = streamText({
      model: chatModel,
      prompt: 'Use the lookup tool',
      tools: {
        lookup: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => value,
        }),
      },
      stopWhen: stepCountIs(5),
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['го', 'тово']);
    expect(await result.text).toBe('готово');
    expect(requestBodies).toHaveLength(2);
  });

  it('runs sequential tool calls through GPT-5.6 Terra', async () => {
    const requestBodies: RequestBody[] = [];
    const responses = [
      chatResponse(null, 'tool_calls', [
        {
          id: 'call-first',
          type: 'function',
          function: { name: 'first', arguments: '{"value":"one"}' },
        },
      ]),
      chatResponse(null, 'tool_calls', [
        {
          id: 'call-second',
          type: 'function',
          function: { name: 'second', arguments: '{"value":"two"}' },
        },
      ]),
      chatResponse('done', 'stop'),
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as RequestBody);
        return jsonResponse(responses.shift());
      }),
    );

    const prompt = splitSystemMessages([
      { role: 'system', content: 'Use tools when needed' },
      { role: 'user', content: 'Run both tools' },
    ]);

    const result = await generateText({
      model: chatModel,
      instructions: prompt.instructions,
      messages: prompt.messages,
      tools: {
        first: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => value,
        }),
        second: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => value,
        }),
      },
      stopWhen: stepCountIs(5),
    });

    expect(result.text).toBe('done');
    expect(requestBodies[0]?.messages?.[0]).toEqual({
      role: 'system',
      content: 'Use tools when needed',
    });
    expect(requestBodies).toHaveLength(3);
    expect(
      requestBodies.every((body) => body.model === 'openai/gpt-5.6-terra'),
    ).toBe(true);
  });

  it('requests JSON Schema structured output through Nex-N2-Mini', async () => {
    let requestBody: RequestBody = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as RequestBody;
        return jsonResponse(chatResponse('{"answer":"ok"}', 'stop'));
      }),
    );

    const result = await generateText({
      model: utilityModel,
      prompt: 'Return JSON',
      output: Output.object({ schema: z.object({ answer: z.string() }) }),
    });

    expect(result.output).toEqual({ answer: 'ok' });
    expect(requestBody.model).toBe('nex-agi/nex-n2-mini');
    expect(requestBody.response_format?.type).toBe('json_schema');
  });

  it('sends image input through Nex-N2-Mini', async () => {
    let requestBody: RequestBody = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as RequestBody;
        return jsonResponse(chatResponse('an image', 'stop'));
      }),
    );

    await generateText({
      model: utilityModel,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              mediaType: 'image/jpeg',
              data: {
                type: 'data',
                data: new Uint8Array([1, 2, 3]),
              },
            },
          ],
        },
      ],
    });

    expect(requestBody.model).toBe('nex-agi/nex-n2-mini');
    const content = requestBody.messages?.[0]?.content;
    expect(Array.isArray(content) && content[0]?.type).toBe('image_url');
    expect(Array.isArray(content) && content[0]?.image_url?.url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });
});
