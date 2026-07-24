import { customAlphabet } from 'nanoid';

const showError = (msg: string) => {
  throw new Error(msg);
};

export const token = process.env.TOKEN || showError('token not found in .env');
export const openWeatherToken =
  process.env.OPEN_WEATHER_TOKEN || showError('token not found in .env');
export const yandexCloudToken =
  process.env.YANDEX_CLOUD_TOKEN || showError('token not found in .env');
export const yandexS3ID =
  process.env.YANDEX_S3_ID || showError('token not found in .env');
export const yandexS3Secret =
  process.env.YANDEX_S3_SECRET || showError('token not found in .env');
export const routerAIToken =
  process.env.ROUTERAI_API_KEY || showError('token not found in .env');
export const qdrantBaseURL =
  process.env.QDRANT_BASE_URL || showError('token not found in .env');
export const qdrantApiKey =
  process.env.QDRANT_API_KEY || showError('token not found in .env');

console.log('Using Qdrant Base URL:', qdrantBaseURL);

export const langfuseConfig = {
  secretKey:
    process.env.LANGFUSE_SECRET_KEY ||
    showError('LANGFUSE_SECRET_KEY not found in .env'),
  publicKey:
    process.env.LANGFUSE_PUBLIC_KEY ||
    showError('LANGFUSE_PUBLIC_KEY not found in .env'),
  baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
  environment: process.env.LANGFUSE_ENVIRONMENT || 'development',
};

export const activateWordList = ['ио', 'форонида', 'io'];

export const sessionIdGenerator = customAlphabet(
  '1234567890abcdefghijklmnopqrstuvwxyz',
  10,
);
