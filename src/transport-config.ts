export type BotMode = 'polling' | 'webhook';

export interface PollingTransportConfig {
  mode: 'polling';
}

export interface WebhookTransportConfig {
  mode: 'webhook';
  webhookUrl: string;
  webhookPath: string;
  webhookSecret: string;
  webhookTimeoutMs: number;
}

export type TransportConfig = PollingTransportConfig | WebhookTransportConfig;

const DEFAULT_WEBHOOK_TIMEOUT_MS = 50_000;
const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required when BOT_MODE=webhook`);
  }
  return value;
}

function parseWebhookTimeout(value: string | undefined): number {
  const timeout = Number(value || DEFAULT_WEBHOOK_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error('WEBHOOK_TIMEOUT_MS must be a positive integer');
  }
  return timeout;
}

export function readTransportConfig(
  env: Record<string, string | undefined>,
): TransportConfig {
  const mode =
    env.BOT_MODE || (env.NODE_ENV === 'production' ? 'webhook' : 'polling');

  if (mode === 'polling') {
    return { mode };
  }

  if (mode !== 'webhook') {
    throw new Error('BOT_MODE must be either polling or webhook');
  }

  const webhookUrl = required(env.WEBHOOK_URL, 'WEBHOOK_URL');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(webhookUrl);
  } catch {
    throw new Error('WEBHOOK_URL must be a valid HTTPS URL');
  }

  if (parsedUrl.protocol !== 'https:' || parsedUrl.pathname === '/') {
    throw new Error('WEBHOOK_URL must be an HTTPS URL with a non-root path');
  }

  const webhookSecret = required(env.WEBHOOK_SECRET, 'WEBHOOK_SECRET');
  if (!WEBHOOK_SECRET_PATTERN.test(webhookSecret)) {
    throw new Error(
      'WEBHOOK_SECRET must contain only letters, numbers, underscores, or hyphens',
    );
  }

  return {
    mode,
    webhookUrl,
    webhookPath: parsedUrl.pathname,
    webhookSecret,
    webhookTimeoutMs: parseWebhookTimeout(env.WEBHOOK_TIMEOUT_MS),
  };
}
