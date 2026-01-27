import { pino } from 'pino';

export const logger = pino({
  level: 'debug',
  // transport: process.env.NODE_ENV !== 'production' ? {
  //   target: 'pino-pretty'
  // } : undefined,
  transport: {
    target: 'pino-pretty',
  },
});
