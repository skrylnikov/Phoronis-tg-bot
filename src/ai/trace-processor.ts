import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  type Attributes,
  type Context,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import { logger } from '../logger';
import { sanitizeTraceData, tracePolicy } from './trace-data';

const resourceSafeKey =
  /^(?:service\.(?:name|version|namespace)|deployment\.environment(?:\.name)?|telemetry\.sdk\.(?:name|version|language))$/;

const privateSafeKey =
  /^(?:user\.id|session\.id|phoronis\.private_mode|ai\.usage\..*|gen_ai\.(?:operation\.name|provider\.name|request\.(?:model|temperature|max_tokens|top_p|top_k|frequency_penalty|presence_penalty)|response\.(?:model|id|finish_reasons)|usage\..*|client\.operation\..*|tool\.(?:name|type|call\.id)|execute_tool\.duration)|langfuse\.(?:environment|release|internal\..*|observation\.(?:type|model|usage_details|model_parameters)|(?:trace|observation)\.metadata\.(?:threadId|promptHash|promptVersion|cacheBoundary|chatType|chatId|messageId|updateId|inputCharacters|inputMessageCount|outputCharacters|stablePrefixCharacters|dynamicCharacters|latencyMs|ttftMs|finishReason|partial|providerCacheRead|providerCacheWrite|contentExcludedReason)))$/;

function cleanAttributes(
  attributes: Attributes,
  privateMode: boolean,
): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) => {
      if (privateMode && !privateSafeKey.test(key)) return [];
      const cleaned = sanitizeTraceData(value);
      return cleaned === undefined
        ? []
        : [
            [
              String(sanitizeTraceData(key)),
              typeof cleaned === 'object' && !Array.isArray(cleaned)
                ? JSON.stringify(cleaned)
                : cleaned,
            ],
          ];
    }),
  ) as Attributes;
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export class AiTraceProcessor extends LangfuseSpanProcessor {
  override onStart(span: Span, parentContext: Context): void {
    const policy = tracePolicy.getStore();
    span.setAttribute('phoronis.private_mode', policy?.privateMode ?? false);
    if (span.attributes['gen_ai.operation.name'] === 'chat' && policy) {
      policy.modelSpan = span;
      if (policy.modelParameters)
        span.setAttribute(
          'langfuse.observation.model_parameters',
          JSON.stringify(policy.modelParameters),
        );
    }
    const toolId = span.attributes['gen_ai.tool.call.id'];
    if (
      policy &&
      span.attributes['gen_ai.operation.name'] === 'execute_tool' &&
      typeof toolId === 'string'
    ) {
      policy.toolSpans ??= new Map();
      policy.toolSpans.set(toolId, span);
    }
    try {
      super.onStart(span, parentContext);
    } catch {
      /* Telemetry cannot interrupt generation. */
    }
  }

  override onEnd(span: ReadableSpan): void {
    try {
      const privateMode = span.attributes['phoronis.private_mode'] === true;
      const attributes = cleanAttributes(span.attributes, privateMode);
      const operation = attributes['gen_ai.operation.name'];
      const generation = operation === 'chat' && span.kind === SpanKind.CLIENT;
      const tool = operation === 'execute_tool';
      if (operation)
        attributes['langfuse.observation.type'] = generation
          ? 'generation'
          : tool
            ? 'tool'
            : 'span';
      if (generation) {
        attributes['langfuse.observation.model'] =
          attributes['gen_ai.response.model'] ??
          attributes['gen_ai.request.model'];
        const usage = Object.fromEntries(
          [
            ['input', attributes['gen_ai.usage.input_tokens']],
            ['output', attributes['gen_ai.usage.output_tokens']],
            [
              'cache_read_input_tokens',
              attributes['gen_ai.usage.cache_read.input_tokens'],
            ],
            [
              'cache_creation_input_tokens',
              attributes['gen_ai.usage.cache_creation.input_tokens'],
            ],
            [
              'reasoning_output_tokens',
              attributes['ai.usage.outputTokenDetails.reasoningTokens'],
            ],
          ].filter(([, value]) => typeof value === 'number'),
        );
        if (typeof usage.input === 'number' && typeof usage.output === 'number')
          usage.total = usage.input + usage.output;
        attributes['langfuse.observation.usage_details'] =
          JSON.stringify(usage);
        attributes['langfuse.observation.metadata.providerCacheRead'] =
          usage.cache_read_input_tokens ?? 'unavailable';
        attributes['langfuse.observation.metadata.providerCacheWrite'] =
          usage.cache_creation_input_tokens ?? 'unavailable';
      } else {
        // Aggregate SDK spans are containers; only actual model calls are billable.
        for (const key of Object.keys(attributes))
          if (key.startsWith('gen_ai.usage.') || key.startsWith('ai.usage.'))
            delete attributes[key];
      }
      if (!privateMode && (generation || tool)) {
        const input = tool
          ? parsed(attributes['gen_ai.tool.call.arguments'])
          : {
              instructions: parsed(attributes['gen_ai.system_instructions']),
              messages: parsed(attributes['gen_ai.input.messages']),
              tools: parsed(attributes['gen_ai.tool.definitions']),
            };
        const output = parsed(
          attributes[
            tool ? 'gen_ai.tool.call.result' : 'gen_ai.output.messages'
          ],
        );
        if (input !== undefined)
          attributes['langfuse.observation.input'] = JSON.stringify(
            sanitizeTraceData(input),
          );
        if (output !== undefined)
          attributes['langfuse.observation.output'] = JSON.stringify(
            sanitizeTraceData(output),
          );
      }
      if (privateMode)
        attributes['langfuse.observation.metadata.contentExcludedReason'] =
          'private-mode';
      const toolOutput = parsed(
        parsed(span.attributes['gen_ai.tool.call.result']),
      );
      const toolFailed =
        tool &&
        toolOutput !== null &&
        typeof toolOutput === 'object' &&
        'error' in toolOutput;
      const status = toolFailed
        ? { code: SpanStatusCode.ERROR, message: 'Tool returned an error' }
        : {
            ...span.status,
            message: span.status.message
              ? privateMode
                ? 'AI operation failed'
                : String(sanitizeTraceData(span.status.message))
              : undefined,
          };
      if (status.code === SpanStatusCode.ERROR) {
        attributes['langfuse.observation.level'] = 'ERROR';
        attributes['langfuse.observation.status_message'] =
          status.message ?? 'AI operation failed';
      }
      const cleaned: ReadableSpan = {
        kind: span.kind,
        parentSpanContext: span.parentSpanContext,
        startTime: span.startTime,
        endTime: span.endTime,
        duration: span.duration,
        ended: span.ended,
        instrumentationScope: span.instrumentationScope,
        droppedAttributesCount: span.droppedAttributesCount,
        droppedEventsCount: span.droppedEventsCount,
        droppedLinksCount: span.droppedLinksCount,
        links: span.links.map((link) => ({
          ...link,
          attributes: cleanAttributes(link.attributes ?? {}, privateMode),
        })),
        name: String(sanitizeTraceData(span.name)),
        spanContext: () => span.spanContext(),
        attributes,
        status,
        events: privateMode
          ? []
          : span.events.map((event) => ({
              ...event,
              name: String(sanitizeTraceData(event.name)),
              attributes: cleanAttributes(event.attributes ?? {}, false),
            })),
        resource: resourceFromAttributes(
          cleanAttributes(
            Object.fromEntries(
              Object.entries(span.resource.attributes).filter(([key]) =>
                resourceSafeKey.test(key),
              ),
            ),
            false,
          ),
        ),
      };
      super.onEnd(cleaned);
    } catch {
      // Fail closed: a telemetry projection failure must never export raw data.
      logger.warn(
        { event: 'telemetry.span_sanitization_failed' },
        'Dropped an AI span after telemetry sanitization failed',
      );
    }
  }
}
