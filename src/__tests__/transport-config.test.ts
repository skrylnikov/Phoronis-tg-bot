import { describe, expect, it } from 'vitest';
import { readTransportConfig } from '../transport-config';

describe('transport configuration', () => {
  it('defaults non-production to polling', () => {
    expect(readTransportConfig({ NODE_ENV: 'development' })).toEqual({
      mode: 'polling',
    });
  });

  it('requires webhook settings in production', () => {
    expect(() => readTransportConfig({ NODE_ENV: 'production' })).toThrow(
      'WEBHOOK_URL is required',
    );
  });

  it('validates a webhook URL and secret', () => {
    expect(
      readTransportConfig({
        BOT_MODE: 'webhook',
        WEBHOOK_URL: 'https://bot.example.test/telegram/webhook',
        WEBHOOK_SECRET: 'secret_123',
      }),
    ).toMatchObject({
      mode: 'webhook',
      webhookPath: '/telegram/webhook',
      webhookTimeoutMs: 50_000,
    });
  });

  it('rejects an unsafe webhook secret', () => {
    expect(() =>
      readTransportConfig({
        BOT_MODE: 'webhook',
        WEBHOOK_URL: 'https://bot.example.test/telegram/webhook',
        WEBHOOK_SECRET: 'secret with spaces',
      }),
    ).toThrow('WEBHOOK_SECRET must contain only');
  });
});
