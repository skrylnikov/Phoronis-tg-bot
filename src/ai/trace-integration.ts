import { LangfuseVercelAiSdkIntegration } from '@langfuse/vercel-ai-sdk';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Telemetry } from 'ai';
import { logger } from '../logger';
import { tracePolicy } from './trace-data';

// Guard SDK callbacks without ever repeating a model or tool execution.
export function isolateTelemetry(integration: Telemetry): Telemetry {
  return new Proxy(integration, {
    get(target, key, receiver) {
      const method = Reflect.get(target, key, receiver);
      if (typeof method !== 'function') return method;
      if (key === 'executeTool' || key === 'executeLanguageModelCall') {
        return async (options: { execute: () => PromiseLike<unknown> }) => {
          let operation: Promise<unknown> | undefined;
          const execute = () =>
            (operation ??= Promise.resolve().then(options.execute));
          try {
            return await method.call(target, { ...options, execute });
          } catch {
            return execute();
          }
        };
      }
      return async (...args: unknown[]) => {
        try {
          await method.apply(target, args);
        } catch {
          logger.warn(
            { event: 'telemetry.callback_failed', callback: String(key) },
            'AI telemetry callback failed',
          );
        }
      };
    },
  });
}

class ChatTelemetry extends LangfuseVercelAiSdkIntegration {
  override onError(error: unknown): void {
    const policy = tracePolicy.getStore();
    if (policy?.modelSpan) {
      policy.modelSpan.setAttributes({
        'langfuse.observation.metadata.partial': Boolean(policy.partialText),
        'langfuse.observation.metadata.finishReason': policy.cancelled
          ? 'cancelled'
          : 'error',
      });
      if (!policy.privateMode && policy.partialText)
        policy.modelSpan.setAttribute(
          'langfuse.observation.output',
          JSON.stringify(policy.partialText),
        );
    }
    super.onError(error);
    if (policy) policy.modelSpan = undefined;
  }

  override onToolExecutionEnd(
    event: Parameters<LangfuseVercelAiSdkIntegration['onToolExecutionEnd']>[0],
  ): void {
    const policy = tracePolicy.getStore();
    let output: unknown =
      event.toolOutput.type === 'tool-result'
        ? event.toolOutput.output
        : undefined;
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output);
      } catch {}
    }
    if (
      event.toolOutput.type === 'tool-error' ||
      (output !== null && typeof output === 'object' && 'error' in output)
    ) {
      policy?.toolSpans?.get(event.toolCall.toolCallId)?.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'Tool execution failed',
      });
    }
    super.onToolExecutionEnd(event);
    policy?.toolSpans?.delete(event.toolCall.toolCallId);
  }

  override onLanguageModelCallStart(
    event: Parameters<
      LangfuseVercelAiSdkIntegration['onLanguageModelCallStart']
    >[0],
  ): void {
    const policy = tracePolicy.getStore();
    if (policy) policy.partialText = '';
    super.onLanguageModelCallStart(event);
  }

  override onLanguageModelCallEnd(
    event: Parameters<
      LangfuseVercelAiSdkIntegration['onLanguageModelCallEnd']
    >[0],
  ): void {
    const reasoning = event.usage.outputTokenDetails?.reasoningTokens;
    if (reasoning !== undefined)
      tracePolicy
        .getStore()
        ?.modelSpan?.setAttribute(
          'ai.usage.outputTokenDetails.reasoningTokens',
          reasoning,
        );
    super.onLanguageModelCallEnd(event);
    const policy = tracePolicy.getStore();
    if (policy) policy.modelSpan = undefined;
  }

  override onAbort(
    event: Parameters<LangfuseVercelAiSdkIntegration['onAbort']>[0],
  ): void {
    const policy = tracePolicy.getStore();
    if (policy) policy.cancelled = true;
    // The native abort hook ends spans but doesn't mark them as cancelled.
    this.onError({
      callId: event.callId,
      error: new Error('AI generation cancelled'),
    });
    super.onAbort(event);
  }
}

export const chatTelemetry = isolateTelemetry(new ChatTelemetry());
