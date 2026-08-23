import { describe, expect, it } from 'vitest';
import { readLangfuseConfig } from '../langfuse-config';

describe('Langfuse config', () => {
  it('reads v5 credentials, endpoint, and tracing environment', () => {
    expect(
      readLangfuseConfig({
        LANGFUSE_SECRET_KEY: 'sk-test',
        LANGFUSE_PUBLIC_KEY: 'pk-test',
        LANGFUSE_BASE_URL: 'https://langfuse.example.com',
        LANGFUSE_TRACING_ENVIRONMENT: 'staging',
        LANGFUSE_ENVIRONMENT: 'legacy',
      }),
    ).toEqual({
      secretKey: 'sk-test',
      publicKey: 'pk-test',
      baseUrl: 'https://langfuse.example.com',
      environment: 'staging',
    });
  });

  it('does not pass the legacy environment name to v5 config', () => {
    expect(
      readLangfuseConfig({
        LANGFUSE_SECRET_KEY: 'sk-test',
        LANGFUSE_PUBLIC_KEY: 'pk-test',
        LANGFUSE_ENVIRONMENT: 'legacy',
      }).environment,
    ).toBe('development');
  });
});
