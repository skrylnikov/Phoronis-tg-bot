import { readQueueConfig } from './runtime-config';

export const queueConfig = readQueueConfig(process.env);
