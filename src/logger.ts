import { AsyncLocalStorage } from 'node:async_hooks';
import { pino } from 'pino';
import type { BotContext } from './bot';

export type LogFormat = 'json' | 'pretty';

export interface LogContext {
  updateId?: number;
  updateType?: string;
  userId?: number;
  username?: string;
  chatId?: number;
  chatType?: string;
  messageId?: number;
  replyToMessageId?: number;
  callbackQueryId?: string;
}

export const logContextStorage = new AsyncLocalStorage<LogContext>();

export function resolveLogFormat(
  env: Record<string, string | undefined> = process.env,
): LogFormat {
  const configured = env.LOG_FORMAT?.toLowerCase();
  if (configured === 'json' || configured === 'pretty') {
    return configured;
  }

  return env.NODE_ENV === 'production' ? 'json' : 'pretty';
}

export function resolveLogLevel(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.LOG_LEVEL || (env.NODE_ENV === 'production' ? 'info' : 'debug');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const details: Record<string, unknown> = {
      type: error.name,
      message: error.message,
      stack: error.stack,
    };
    const errorWithCode = error as Error & { code?: unknown };
    if (errorWithCode.code !== undefined) {
      details.code = errorWithCode.code;
    }
    return details;
  }

  if (isRecord(error)) {
    return {
      type: typeof error.type === 'string' ? error.type : 'UnknownError',
      message:
        typeof error.message === 'string'
          ? error.message
          : typeof error.description === 'string'
            ? error.description
            : 'Unknown error',
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
    };
  }

  return { type: typeof error, message: String(error) };
}

export function telegramLogContext(ctx: BotContext): LogContext {
  const update = ctx.update as unknown as Record<string, unknown>;
  const message = ctx.msg;

  return {
    updateId:
      typeof update.update_id === 'number' ? update.update_id : undefined,
    updateType: Object.keys(update).find((key) => key !== 'update_id'),
    userId: ctx.from?.id,
    username: ctx.from?.username,
    chatId: ctx.chat?.id,
    chatType: ctx.chat?.type,
    messageId: message?.message_id,
    replyToMessageId: message?.reply_to_message?.message_id,
    callbackQueryId: ctx.callbackQuery?.id,
  };
}

export function withLogContext<T>(context: LogContext, callback: () => T): T {
  return logContextStorage.run(context, callback);
}

const format = resolveLogFormat();

export const logger = pino({
  level: resolveLogLevel(),
  base: {
    service: 'phoronis-bot',
    environment: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label, number) => ({
      level: number,
      severity: label.toUpperCase(),
    }),
  },
  serializers: {
    err: serializeError,
  },
  mixin: () => ({
    event: 'application.log',
    ...logContextStorage.getStore(),
  }),
  ...(format === 'pretty'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname,service,environment,event',
          },
        },
      }
    : {}),
});
