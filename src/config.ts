import { config } from 'dotenv';

config();

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

export const activateWordList = ['ио', 'форонида', 'io', 'иа'];


