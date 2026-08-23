import { readJobConfig } from './runtime-config';

export const jobConfig = readJobConfig(process.env);
