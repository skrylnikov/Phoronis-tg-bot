import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { configureGlobalLogger } from '@langfuse/core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { stepCountIs, streamText, tool, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import { updateAiObservation, withAiObservation } from '../ai/langfuse';
import { sanitizeTraceData, tracePolicy } from '../ai/trace-data';
import { chatTelemetry } from '../ai/trace-integration';
import { AiTraceProcessor } from '../ai/trace-processor';
import { createRuntimeShutdown } from '../runtime-shutdown';

interface WireAttribute {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
    arrayValue?: { values: WireAttribute['value'][] };
  };
}
interface WireSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  endTimeUnixNano: string;
  attributes: WireAttribute[];
  events?: unknown[];
  status?: { code?: number; message?: string };
}
interface WireBatch {
  resourceSpans: Array<{ scopeSpans: Array<{ spans: WireSpan[] }> }>;
}
function attributes(span: WireSpan): Record<string, unknown> {
  return Object.fromEntries(
    span.attributes.map(({ key, value }) => [
      key,
      value.stringValue ??
        value.intValue ??
        value.doubleValue ??
        value.boolValue ??
        value.arrayValue,
    ]),
  );
}

/** Local synthetic traffic only: never sends data to Telegram, RouterAI or Langfuse Cloud. */
export async function runLangfuseSmoke(): Promise<
  Record<string, number | boolean>
> {
  configureGlobalLogger({ level: 2 });
  const batches: WireBatch[] = [];
  let outage = false;
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (outage) {
      response.writeHead(503).end('{}');
      return;
    }
    assert.equal(request.url, '/api/public/otel/v1/traces');
    batches.push(JSON.parse(Buffer.concat(chunks).toString()) as WireBatch);
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, '127.0.0.1', resolve),
  );
  const address = receiver.address();
  assert(address && typeof address === 'object');
  const processor = new AiTraceProcessor({
    baseUrl: `http://127.0.0.1:${address.port}`,
    publicKey: 'smoke-public',
    secretKey: 'smoke-secret',
    environment: 'smoke',
    exportMode: 'batched',
    flushInterval: 60,
    timeout: 0.25,
    mediaUploadEnabled: false,
    mask: ({ data }) => sanitizeTraceData(data),
  });
  const sdk = new NodeSDK({
    spanProcessors: [processor],
    autoDetectResources: false,
  });
  sdk.start();
  const allSpans = () =>
    batches.flatMap((batch) =>
      batch.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
  let modelCalls = 0;
  let toolCalls = 0;
  const parameterBodies: Array<Record<string, unknown>> = [];
  const privateText = 'PRIVATE-SENTINEL-CONTENT';
  const secretText = 'sk-lf-sentinel-secret-value-123456';

  async function run(
    options: {
      privateMode?: boolean;
      name?: 'chat-generation' | 'guest-generation';
      error?: boolean;
      structuredError?: boolean;
      thrownTool?: boolean;
      abort?: boolean;
      unknownUsage?: boolean;
      lite?: boolean;
      traced?: boolean;
      session?: string;
    } = {},
  ): Promise<string> {
    let step = 0;
    const controller = new AbortController();
    const content = options.privateMode
      ? privateText
      : `public question ${secretText}`;
    const provider = createOpenAICompatible({
      name: 'routerAI',
      baseURL: 'http://unused.invalid/v1',
      fetch: Object.assign(
        async (_url: string | URL | Request, init?: RequestInit) => {
          modelCalls++;
          step++;
          parameterBodies.push(JSON.parse(String(init?.body)));
          if (options.error) throw new Error(`${content} Bearer ${secretText}`);
          const choices =
            step === 1 && !options.abort
              ? [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call-lookup',
                          type: 'function',
                          function: {
                            name: 'lookup',
                            arguments: JSON.stringify({ value: content }),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                  { index: 0, delta: {}, finish_reason: 'tool_calls' },
                ]
              : [
                  {
                    index: 0,
                    delta: { role: 'assistant', content },
                    finish_reason: null,
                  },
                  { index: 0, delta: {}, finish_reason: 'stop' },
                ];
          const chunks = choices.map((choice) => ({
            id: 'response-smoke',
            model: options.lite ? 'lite-actual' : 'primary-actual',
            choices: [choice],
            created: 1,
            object: 'chat.completion.chunk',
          }));
          if (!options.unknownUsage)
            chunks.push({
              ...chunks[0],
              choices: [],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
                prompt_tokens_details: { cached_tokens: 10 },
                completion_tokens_details: { reasoning_tokens: 5 },
              },
            } as (typeof chunks)[number]);
          const stream = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
          if (options.abort) {
            const first = `data: ${JSON.stringify(chunks[0])}\n\n`;
            return new Response(
              new ReadableStream({
                start(streamController) {
                  streamController.enqueue(new TextEncoder().encode(first));
                  controller.signal.addEventListener(
                    'abort',
                    () => streamController.error(controller.signal.reason),
                    { once: true },
                  );
                },
                cancel() {},
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          return new Response(stream, {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
        { preconnect: () => {} },
      ),
    });
    const baseModel = provider(
      options.lite ? 'lite-requested' : 'primary-requested',
    );
    const model = options.lite
      ? wrapLanguageModel({
          model: baseModel,
          middleware: {
            transformParams: async ({ params }) => ({
              ...params,
              providerOptions: { routerAI: { reasoningEffort: 'medium' } },
            }),
          },
        })
      : baseModel;
    const generate = async (
      observation?: Parameters<typeof updateAiObservation>[0],
    ) => {
      const policy = tracePolicy.getStore();
      if (policy)
        policy.modelParameters = {
          temperature: 1,
          ...(options.lite ? { reasoningEffort: 'medium' } : {}),
        };
      const input = {
        instructions: [{ role: 'system' as const, content }],
        messages: [{ role: 'user' as const, content }],
      };
      updateAiObservation(observation, { input });
      const result = streamText({
        ...input,
        model,
        temperature: 1,
        maxRetries: 0,
        abortSignal: controller.signal,
        stopWhen: stepCountIs(3),
        ...(policy
          ? {
              telemetry: {
                integrations: [chatTelemetry],
                recordInputs: !policy.privateMode,
                recordOutputs: !policy.privateMode,
                includeRuntimeContext: {},
                includeToolsContext: {},
              },
            }
          : {}),
        tools: {
          lookup: tool({
            inputSchema: z.object({ value: z.string() }),
            execute: async ({ value }) => {
              toolCalls++;
              if (options.thrownTool) throw new Error(value);
              return options.structuredError
                ? JSON.stringify({ error: value })
                : {
                    value,
                    Authorization: secretText,
                    image: 'data:image/png;base64,ABC',
                  };
            },
          }),
        },
        onChunk: ({ chunk }) => {
          if (policy && chunk.type === 'text-delta')
            policy.partialText = (policy.partialText ?? '') + chunk.text;
        },
        onError: () => {},
      });
      let partial = '';
      try {
        for await (const delta of result.textStream) {
          partial += delta;
          if (options.abort) controller.abort();
        }
        if (controller.signal.aborted)
          throw new Error('AI generation cancelled');
        const text = await result.text;
        updateAiObservation(observation, {
          output: text,
          metadata: { outputCharacters: text.length },
        });
        return text;
      } catch (error) {
        updateAiObservation(observation, {
          output: partial,
          level: 'ERROR',
          statusMessage: options.abort
            ? 'AI generation cancelled'
            : 'AI generation failed',
          metadata: {
            partial: Boolean(partial),
            finishReason: options.abort ? 'cancelled' : 'error',
          },
        });
        throw error;
      }
    };
    return options.traced === false
      ? generate()
      : withAiObservation(
          options.name ?? 'chat-generation',
          {
            privateMode: options.privateMode,
            sessionId: options.session ?? 'session-smoke',
            userId: '42',
            metadata: {
              threadId: options.session ?? 'thread-smoke',
              promptHash: 'smoke-hash',
              promptVersion: 3,
              cacheBoundary: 1,
              chatId: '-100',
              messageId: '200',
              updateId: '300',
            },
          },
          generate,
        );
  }

  try {
    const before = modelCalls;
    await run();
    assert.equal(modelCalls - before, 2);
    assert.equal(toolCalls, 1);
    assert.equal(
      allSpans().length,
      0,
      'spans should remain batched before flush',
    );
    await processor.forceFlush();
    const spans = allSpans();
    const root = spans.find((span) => span.name === 'chat-generation');
    assert(root);
    const rootAttrs = attributes(root);
    for (const key of [
      'langfuse.observation.input',
      'langfuse.observation.output',
      'langfuse.trace.input',
      'langfuse.trace.output',
    ])
      assert(rootAttrs[key], `missing ${key}`);
    const generations = spans.filter(
      (span) => attributes(span)['langfuse.observation.type'] === 'generation',
    );
    const tools = spans.filter(
      (span) => attributes(span)['langfuse.observation.type'] === 'tool',
    );
    assert.equal(generations.length, 2);
    assert.equal(tools.length, 1);
    assert.equal(attributes(tools[0])['gen_ai.tool.call.id'], 'call-lookup');
    assert(
      spans.every(
        (span) => span.traceId === root.traceId && span.endTimeUnixNano,
      ),
    );
    assert(
      spans
        .filter((span) => span !== root)
        .every((span) =>
          spans.some((parent) => parent.spanId === span.parentSpanId),
        ),
    );
    for (const span of generations) {
      const attrs = attributes(span);
      assert.equal(attrs['langfuse.observation.model'], 'primary-actual');
      assert.equal(attrs['gen_ai.provider.name'], 'routerAI.chat');
      const usage = JSON.parse(
        String(attrs['langfuse.observation.usage_details']),
      );
      assert.equal(usage.input, 100);
      assert.equal(usage.output, 20);
      assert.equal(usage.total, 120);
      assert.equal(usage.cache_read_input_tokens, 10);
      assert.equal(usage.reasoning_output_tokens, 5);
      assert(attrs['gen_ai.response.finish_reasons']);
      assert(
        attrs['gen_ai.client.operation.time_to_first_chunk'] !== undefined,
      );
    }
    assert(
      spans
        .filter((span) => !generations.includes(span))
        .every(
          (span) => !attributes(span)['langfuse.observation.usage_details'],
        ),
    );
    assert(!JSON.stringify(batches).includes(secretText));
    assert(!JSON.stringify(batches).includes('data:image'));

    await Promise.all([
      run({ privateMode: true, session: 'private-session' }),
      run({ name: 'guest-generation', session: 'guest-session', lite: true }),
    ]);
    await run({ privateMode: true, error: true }).catch(() => {});
    await run({ structuredError: true });
    await run({ privateMode: true, structuredError: true });
    await run({ privateMode: true, thrownTool: true });
    await run({ thrownTool: true });
    await run({ abort: true }).catch(() => {});
    await run({ privateMode: true, abort: true }).catch(() => {});
    await run({ unknownUsage: true });
    const countBeforeUntraced = allSpans().length;
    await run({ traced: false });
    await processor.forceFlush();
    assert(allSpans().length > countBeforeUntraced);
    assert(!JSON.stringify(batches).includes(privateText));
    const privateSpans = allSpans().filter(
      (span) => attributes(span)['phoronis.private_mode'] === true,
    );
    assert(privateSpans.length > 0);
    assert(
      privateSpans.every(
        (span) =>
          !attributes(span)['langfuse.observation.input'] &&
          !attributes(span)['langfuse.observation.output'] &&
          !span.events?.length,
      ),
    );
    assert(
      allSpans().some(
        (span) =>
          attributes(span)['langfuse.observation.model_parameters'] ===
          '{"temperature":1,"reasoningEffort":"medium"}',
      ),
    );
    assert(parameterBodies.some((body) => body.reasoning_effort === 'medium'));
    assert(
      allSpans().some(
        (span) =>
          attributes(span)['langfuse.observation.type'] === 'tool' &&
          span.status?.code === 2,
      ),
    );
    assert(
      allSpans().some(
        (span) =>
          attributes(span)['langfuse.observation.status_message'] ===
          'AI generation cancelled',
      ),
    );
    assert(
      allSpans().some(
        (span) =>
          attributes(span)['langfuse.observation.usage_details'] === '{}',
      ),
    );

    const cancelledGenerations = allSpans().filter(
      (span) =>
        attributes(span)['langfuse.observation.type'] === 'generation' &&
        attributes(span)['langfuse.observation.metadata.finishReason'] ===
          'cancelled',
    );
    assert.equal(cancelledGenerations.length, 2);
    assert(
      cancelledGenerations.every(
        (span) =>
          span.status?.code === 2 &&
          attributes(span)['langfuse.observation.metadata.partial'] === true,
      ),
    );
    assert(
      cancelledGenerations.some(
        (span) => attributes(span)['langfuse.observation.output'],
      ),
    );
    const privateGeneration = privateSpans.find(
      (span) =>
        attributes(span)['langfuse.observation.type'] === 'generation' &&
        attributes(span)['session.id'] === 'private-session',
    );
    assert(
      privateSpans.filter(
        (span) =>
          attributes(span)['langfuse.observation.type'] === 'tool' &&
          span.status?.code === 2,
      ).length >= 2,
    );
    assert(privateGeneration);
    assert(
      privateSpans.some(
        (span) =>
          attributes(span)['langfuse.observation.type'] === 'generation' &&
          span.status?.code === 2 &&
          span.status.message === 'AI operation failed',
      ),
    );
    assert(allSpans().every((span) => span.endTimeUnixNano));
    assert.equal(attributes(privateGeneration)['user.id'], '42');
    assert.equal(
      attributes(privateGeneration)['langfuse.trace.metadata.promptHash'],
      'smoke-hash',
    );
    const guestRoot = allSpans().find(
      (span) => span.name === 'guest-generation',
    );
    assert(
      guestRoot && attributes(guestRoot)['session.id'] === 'guest-session',
    );
    const spansBefore = allSpans().length;
    await run({ traced: false });
    await processor.forceFlush();
    assert.equal(
      allSpans().length,
      spansBefore,
      'untraced AI paths must not create spans',
    );
    outage = true;
    const callsBeforeOutage = modelCalls;
    assert(await run());
    await processor.forceFlush().catch(() => {});
    assert.equal(modelCalls - callsBeforeOutage, 2);
    outage = false;
    const beforeShutdown = allSpans().length;
    await run({ name: 'guest-generation' });
    const shutdown = createRuntimeShutdown({
      drainMs: 2000,
      stopHealthServer: () => {},
      stopTransport: async () => {},
      stopJobRunner: async () => {},
      stopEmbeddings: async () => {},
      stopScheduler: async () => {},
      disconnectDatabase: async () => {},
      shutdownTelemetry: () => sdk.shutdown(),
    });
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('SIGTERM flush exceeded budget')),
        2500,
      );
      process.once('SIGTERM', () => {
        void shutdown()
          .then(resolve, reject)
          .finally(() => clearTimeout(timer));
      });
      process.kill(process.pid, 'SIGTERM');
    });
    assert(performance.now() - started < 2500);
    assert(allSpans().length > beforeShutdown);
    return {
      spans: allSpans().length,
      generations: allSpans().filter(
        (span) =>
          attributes(span)['langfuse.observation.type'] === 'generation',
      ).length,
      exportedTools: allSpans().filter(
        (span) => attributes(span)['langfuse.observation.type'] === 'tool',
      ).length,
      toolExecutions: toolCalls,
      privateExcluded: true,
      outageNonFatal: true,
      shutdownFlushed: true,
    };
  } finally {
    await sdk.shutdown();
    await new Promise<void>((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

if (import.meta.main) console.log(JSON.stringify(await runLangfuseSmoke()));
