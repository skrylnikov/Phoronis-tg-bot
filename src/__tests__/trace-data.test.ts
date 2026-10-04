import { describe, expect, it, vi } from 'vitest';
import { updateAiObservation } from '../ai/langfuse';
import { sanitizeTraceData } from '../ai/trace-data';
import { isolateTelemetry } from '../ai/trace-integration';

vi.mock('../logger', () => ({ logger: { warn: vi.fn() } }));

describe('trace diagnostic copies', () => {
  it('removes runtime secrets, credentials and attachments without modifying input', () => {
    vi.stubEnv('TRACE_TEST_SECRET_KEY', 'sentinel-runtime-secret');
    const original = {
      text: 'sentinel-runtime-secret Bearer abcdef',
      nested: JSON.stringify({
        Authorization: 'secret-header',
        password: 'secret-password',
        text: 'sentinel-runtime-secret',
      }),
      url: 'https://u:p@example.com/a',
      signed: 'https://example.com/a?X-Amz-Signature=secret-signature',
      data: 'data:image/png;base64,ABC',
      bytes: new Uint8Array([1, 2]),
      base64: 'ABC',
      runtime: new Error('secret-error'),
    };
    const before = JSON.stringify(original);
    const cleaned = JSON.stringify(sanitizeTraceData(original));
    for (const secret of [
      'sentinel-runtime-secret',
      'abcdef',
      'secret-header',
      'secret-password',
      'secret-signature',
      'secret-error',
      'ABC',
      'https://u:p',
    ])
      expect(cleaned).not.toContain(secret);
    expect(JSON.stringify(original)).toBe(before);
    vi.unstubAllEnvs();
  });

  it('excludes plain runtime context and raw base64 payloads', () => {
    expect(sanitizeTraceData({ api: {}, msg: { text: 'sensitive' } })).toBe(
      '[runtime object excluded]',
    );
    expect(sanitizeTraceData('ABCD'.repeat(100))).toBe('[attachment excluded]');
  });
  it('isolates sanitizer exceptions from generation', () => {
    const input = Object.defineProperty({}, 'text', {
      enumerable: true,
      get() {
        throw new Error('PRIVATE SENTINEL');
      },
    });
    const observation = { update: vi.fn(), setTraceIO: vi.fn() };
    expect(() =>
      updateAiObservation(observation as never, { input }),
    ).not.toThrow();
    expect(observation.setTraceIO).not.toHaveBeenCalled();
  });

  it('handles cycles and caps escaped Unicode with valid JSON', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(sanitizeTraceData(cyclic)).toEqual({ self: '[circular]' });
    const cleaned = sanitizeTraceData('😀"\\'.repeat(50000)) as {
      truncated: boolean;
      originalBytes: number;
      preview: string;
    };
    expect(cleaned.truncated).toBe(true);
    expect(cleaned.originalBytes).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(JSON.stringify(cleaned))).toBeLessThanOrEqual(
      128 * 1024,
    );
    expect(cleaned.preview).not.toContain('\uFFFD');
    expect(JSON.parse(JSON.stringify(cleaned))).toEqual(cleaned);
  });
});

describe('telemetry failures cannot retry AI work', () => {
  it('handles a failed callback and failure before execution', async () => {
    const integration = isolateTelemetry({
      onStart: () => {
        throw new Error('telemetry');
      },
      executeTool: () => {
        throw new Error('context');
      },
    });
    await integration.onStart?.({} as never);
    const execute = vi.fn(async () => 'result');
    expect(
      await integration.executeTool?.({
        callId: '1',
        toolCallId: '1',
        execute,
      }),
    ).toBe('result');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('returns the original execution result or failure when context exit fails', async () => {
    const integration = isolateTelemetry({
      executeLanguageModelCall: async ({ execute }) => {
        await execute();
        throw new Error('context exit');
      },
    });
    const execute = vi.fn(async () => 'answer');
    expect(
      await integration.executeLanguageModelCall?.({ callId: '1', execute }),
    ).toBe('answer');
    expect(execute).toHaveBeenCalledTimes(1);
    const original = new Error('provider');
    const fail = vi.fn(async () => {
      throw original;
    });
    await expect(
      integration.executeLanguageModelCall?.({ callId: '2', execute: fail }),
    ).rejects.toBe(original);
    expect(fail).toHaveBeenCalledTimes(1);
  });
});
