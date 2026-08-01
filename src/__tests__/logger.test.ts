import { describe, expect, it } from 'vitest';
import {
  resolveLogFormat,
  resolveLogLevel,
  telegramLogContext,
} from '../logger';

describe('logger configuration', () => {
  it('uses JSON in production and pretty output locally', () => {
    expect(resolveLogFormat({ NODE_ENV: 'production' })).toBe('json');
    expect(resolveLogFormat({ NODE_ENV: 'development' })).toBe('pretty');
    expect(
      resolveLogFormat({ NODE_ENV: 'production', LOG_FORMAT: 'pretty' }),
    ).toBe('pretty');
    expect(
      resolveLogFormat({ NODE_ENV: 'development', LOG_FORMAT: 'json' }),
    ).toBe('json');
  });

  it('uses quieter production logging by default', () => {
    expect(resolveLogLevel({ NODE_ENV: 'production' })).toBe('info');
    expect(resolveLogLevel({ NODE_ENV: 'development' })).toBe('debug');
    expect(resolveLogLevel({ NODE_ENV: 'production', LOG_LEVEL: 'warn' })).toBe(
      'warn',
    );
  });
});

describe('telegramLogContext', () => {
  it('extracts identifiers without message content', () => {
    const context = telegramLogContext({
      update: {
        update_id: 42,
        message: {
          message_id: 7,
          date: 1,
          text: 'private text that must not be logged',
          chat: { id: -1001, type: 'supergroup', title: 'Chat' },
          from: { id: 9, is_bot: false, first_name: 'User', username: 'alice' },
        },
      },
      from: { id: 9, username: 'alice' },
      chat: { id: -1001, type: 'supergroup' },
      chatId: -1001,
      msg: {
        message_id: 7,
        reply_to_message: undefined,
      },
    } as never);

    expect(context).toEqual({
      updateId: 42,
      updateType: 'message',
      userId: 9,
      username: 'alice',
      chatId: -1001,
      chatType: 'supergroup',
      messageId: 7,
      replyToMessageId: undefined,
      callbackQueryId: undefined,
    });
    expect(JSON.stringify(context)).not.toContain('private text');
  });
});
