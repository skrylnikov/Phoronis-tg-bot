import { customAlphabet } from 'nanoid';
import { readJobConfig, readQueueConfig } from './runtime-config';
import { readTransportConfig } from './transport-config';

const showError = (msg: string): never => {
  throw new Error(msg);
};

export const databaseURL = process.env.DATABASE_URL || '';
export const queueConfig = readQueueConfig(process.env);
export const jobConfig = readJobConfig(process.env);
export const shutdownDrainMs = Number(process.env.SHUTDOWN_DRAIN_MS || 30_000);
export { readRuntimeConfig } from './runtime-config';

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
export const paymentSupportContact =
  process.env.PAYMENT_SUPPORT_CONTACT ||
  showError('PAYMENT_SUPPORT_CONTACT not found in .env');
export const analyticsChatId = Number(
  process.env.ANALYTICS_CHAT_ID ||
    showError('ANALYTICS_CHAT_ID not found in .env'),
);
export const embeddingBaseURL =
  process.env.EMBEDDING_BASE_URL ||
  showError('EMBEDDING_BASE_URL not found in .env');
export const embeddingModel =
  process.env.EMBEDDING_MODEL || 'intfloat/multilingual-e5-small';
export const embeddingVersion = Number(process.env.EMBEDDING_VERSION || '1');
export const embeddingTimeoutMs = Number(
  process.env.EMBEDDING_TIMEOUT_MS || '2000',
);
export const transportConfig = readTransportConfig(process.env);

if (!Number.isInteger(embeddingVersion) || embeddingVersion < 1) {
  showError('EMBEDDING_VERSION must be a positive integer');
}

if (!Number.isFinite(embeddingTimeoutMs) || embeddingTimeoutMs < 1) {
  showError('EMBEDDING_TIMEOUT_MS must be a positive number');
}

if (!Number.isSafeInteger(analyticsChatId)) {
  showError('ANALYTICS_CHAT_ID must be a Telegram chat ID');
}

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
