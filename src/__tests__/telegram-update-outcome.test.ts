import { describe, expect, it } from 'vitest';
import {
  mapTelegramUpdateError,
  TerminalUpdateError,
} from '../telegram-update-queue';

describe('Telegram update outcomes', () => {
  it('maps ordinary failures to retryable outcomes', () => {
    const error = new Error('temporary');
    expect(mapTelegramUpdateError(error)).toEqual({
      kind: 'retryable',
      error,
    });
  });

  it('keeps explicit terminal failures out of retry', () => {
    const error = new TerminalUpdateError('invalid update');
    expect(mapTelegramUpdateError(error)).toEqual({
      kind: 'terminal',
      error,
    });
  });
});
