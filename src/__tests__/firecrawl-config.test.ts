import { describe, expect, it, vi } from 'vitest';

describe('optional Firecrawl configuration', () => {
  it('does not require a key for application startup', async () => {
    for (const [name, value] of Object.entries({
      TOKEN: 'token',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/phoronis',
      BOT_MODE: 'polling',
      OPEN_WEATHER_TOKEN: 'weather',
      YANDEX_CLOUD_TOKEN: 'yandex',
      YANDEX_S3_ID: 'id',
      YANDEX_S3_SECRET: 'secret',
      ROUTERAI_API_KEY: 'router',
      PAYMENT_SUPPORT_CONTACT: '@support',
      ANALYTICS_CHAT_ID: '123',
      EMBEDDING_BASE_URL: 'http://localhost:3001',
      LANGFUSE_SECRET_KEY: 'langfuse-secret',
      LANGFUSE_PUBLIC_KEY: 'langfuse-public',
      FIRECRAWL_API_KEY: '',
    })) {
      vi.stubEnv(name, value);
    }

    const config = await import('../config');

    expect(config.firecrawlApiKey).toBeUndefined();
    expect(config.token).toBe('token');
  });
});
