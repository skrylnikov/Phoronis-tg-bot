import { AsyncLocalStorage } from 'node:async_hooks';
import type { Span } from '@opentelemetry/api';

export const tracePolicy = new AsyncLocalStorage<{
  privateMode: boolean;
  modelSpan?: Span;
  toolSpans?: Map<string, Span>;
  modelParameters?: Record<string, string | number>;
  cancelled?: boolean;
  partialText?: string;
}>();
const maxIoBytes = 128 * 1024;
const sensitiveKey =
  /authorization|cookie|password|secret|api[-_]?key|access[-_]?token|headers|requestBody|responseBody|base64/i;

function scrubText(text: string): string {
  let result = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value &&
      value.length >= 8 &&
      /TOKEN|SECRET|KEY|DATABASE_URL/i.test(key)
    ) {
      result = result.split(value).join('[REDACTED]');
    }
  }
  return result
    .replace(/data:[^\s"']+/gi, '[attachment excluded]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/\b(?:sk|pk)-(?:lf-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[REDACTED]',
    )
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*(["']?)[^\s,"'}]+\2/gi,
      '$1=[REDACTED]',
    )
    .replace(/https?:\/\/[^\s"<>]+/gi, (value) => {
      try {
        const url = new URL(value);
        if (
          url.username ||
          url.password ||
          /token|key|signature|credential|x-amz-|secret/i.test(url.search)
        ) {
          return '[credential URL excluded]';
        }
        return value;
      } catch {
        return '[invalid URL]';
      }
    });
}

export function sanitizeTraceData(value: unknown): unknown {
  const seen = new WeakSet<object>();
  function visit(data: unknown, depth: number): unknown {
    if (depth > 30) return '[depth limit]';
    if (typeof data === 'string') {
      if (data.length >= 256 && /^[A-Za-z0-9+/]+={0,2}$/.test(data))
        return '[attachment excluded]';
      const cleaned = scrubText(data);
      // Tool results and OTLP attributes can themselves contain serialized JSON.
      try {
        return JSON.stringify(visit(JSON.parse(cleaned), depth + 1));
      } catch {
        return cleaned;
      }
    }
    if (typeof data === 'bigint') return String(data);
    if (data === null || typeof data !== 'object') return data;
    if (seen.has(data)) return '[circular]';
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer)
      return '[attachment excluded]';
    if (
      'api' in data &&
      ('update' in data || 'msg' in data || 'chatId' in data)
    )
      return '[runtime object excluded]';
    if (data instanceof URL) return scrubText(data.href);
    if (
      !Array.isArray(data) &&
      Object.getPrototypeOf(data) !== Object.prototype &&
      Object.getPrototypeOf(data) !== null
    )
      return '[runtime object excluded]';
    if (
      'type' in data &&
      (data.type === 'file' || data.type === 'image') &&
      ('data' in data || 'file' in data)
    )
      return { type: data.type, content: '[attachment excluded]' };
    seen.add(data);
    const result = Array.isArray(data)
      ? data.map((item) => visit(item, depth + 1))
      : Object.fromEntries(
          Object.entries(data).map(([key, item]) => [
            scrubText(key),
            sensitiveKey.test(key) ? '[REDACTED]' : visit(item, depth + 1),
          ]),
        );
    seen.delete(data);
    return result;
  }
  const cleaned = visit(value, 0);
  const serialized = JSON.stringify(cleaned);
  if (!serialized || Buffer.byteLength(serialized) <= maxIoBytes)
    return cleaned;
  const bytes = new TextEncoder().encode(serialized);
  const result = { truncated: true, originalBytes: bytes.length, preview: '' };
  // Preview escaping also takes bytes; cap the complete serialized envelope.
  let low = 0;
  let high = Math.min(bytes.length, maxIoBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const preview = new TextDecoder().decode(bytes.subarray(0, middle), {
      stream: true,
    });
    if (Buffer.byteLength(JSON.stringify({ ...result, preview })) <= maxIoBytes)
      low = middle;
    else high = middle - 1;
  }
  result.preview = new TextDecoder().decode(bytes.subarray(0, low), {
    stream: true,
  });
  return result;
}
