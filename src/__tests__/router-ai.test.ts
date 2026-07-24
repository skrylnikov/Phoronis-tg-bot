import { embed, generateText, Output, stepCountIs, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../config', () => ({
  routerAIToken: 'test-routerai-token',
}));

import {
  chatModel,
  embeddingModel,
  embeddingProviderOptions,
  utilityModel,
} from '../ai/ai';

interface RequestBody {
  model?: string;
  messages?: Array<{
    content?: Array<{ type?: string; image_url?: { url?: string } }>;
  }>;
  response_format?: { type?: string };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
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
  it('runs sequential tool calls through Gemini 3.6 Flash', async () => {
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

    const result = await generateText({
      model: chatModel,
      prompt: 'Run both tools',
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
    expect(requestBodies).toHaveLength(3);
    expect(
      requestBodies.every((body) => body.model === 'google/gemini-3.6-flash'),
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
              type: 'image',
              image: new Uint8Array([1, 2, 3]),
              mediaType: 'image/jpeg',
            },
          ],
        },
      ],
    });

    expect(requestBody.model).toBe('nex-agi/nex-n2-mini');
    expect(requestBody.messages?.[0]?.content?.[0]?.type).toBe('image_url');
    expect(requestBody.messages?.[0]?.content?.[0]?.image_url?.url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });

  it('requests and accepts a 4096-dimensional Qwen embedding', async () => {
    const embedding = Array.from({ length: 4096 }, (_, index) => index / 4096);
    let requestBody: { model?: string; dimensions?: number } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
        return jsonResponse({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding }],
          model: 'qwen/qwen3-embedding-8b',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }),
    );

    const result = await embed({
      model: embeddingModel,
      value: 'test',
      providerOptions: embeddingProviderOptions,
    });

    expect(requestBody).toMatchObject({
      model: 'qwen/qwen3-embedding-8b',
      dimensions: 4096,
    });
    expect(result.embedding).toHaveLength(4096);
  });
});
