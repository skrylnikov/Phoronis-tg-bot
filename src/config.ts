import { customAlphabet } from 'nanoid'

const showError = (msg: string) => {
  throw new Error(msg)
};


export const token = process.env.TOKEN || showError('token not found in .env');
export const openWeatherToken = process.env.OPEN_WEATHER_TOKEN || showError('token not found in .env');
export const dadataToken = process.env.DADATA_TOKEN || showError('token not found in .env');
export const yandexCloudToken = process.env.YANDEX_CLOUD_TOKEN || showError('token not found in .env');
export const yandexS3ID = process.env.YANDEX_S3_ID || showError('token not found in .env');
export const yandexS3Secret = process.env.YANDEX_S3_SECRET || showError('token not found in .env');
export const openAIToken = process.env.OPENAI_API_KEY || showError('token not found in .env');
export const openRouterToken = process.env.OPENROUTER_API_KEY || showError('token not found in .env');
// export const llamaGateToken = process.env.LLAMAGATE_API_KEY || showError('token not found in .env');
// export const llamaGateBaseURL = process.env.LLAMAGATE_BASE_URL || showError('token not found in .env');
export const qdrantBaseURL = process.env.QDRANT_BASE_URL || showError('token not found in .env');
export const qdrantApiKey = process.env.QDRANT_API_KEY || showError('token not found in .env');

export const langfuseConfig = {
  secretKey: process.env.LANGFUSE_SECRET_KEY || showError('LANGFUSE_SECRET_KEY not found in .env'),
  publicKey: process.env.LANGFUSE_PUBLIC_KEY || showError('LANGFUSE_PUBLIC_KEY not found in .env'),
  baseUrl: process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
  environment: process.env.LANGFUSE_ENVIRONMENT || "development",
};

export const activateWordList = ['ио', 'форонида', 'io', 'иа'];


export const sessionIdGenerator = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyz', 10);
