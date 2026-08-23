export interface LangfuseConfig {
  secretKey: string;
  publicKey: string;
  baseUrl: string;
  environment: string;
}

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} not found in .env`);
  }
  return value;
}

export function readLangfuseConfig(
  env: Record<string, string | undefined>,
): LangfuseConfig {
  return {
    secretKey: required(env, 'LANGFUSE_SECRET_KEY'),
    publicKey: required(env, 'LANGFUSE_PUBLIC_KEY'),
    baseUrl: env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
    environment: env.LANGFUSE_TRACING_ENVIRONMENT || 'development',
  };
}
