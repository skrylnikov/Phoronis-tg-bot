import { afterEach, describe, expect, it, vi } from 'vitest';

const loggerError = vi.hoisted(() => vi.fn());

vi.mock('../logger', () => ({
  logger: { error: loggerError },
}));

import { startTypingStatus } from '../ai/typing-status';

afterEach(() => vi.useRealTimers());

describe('typing status lifecycle', () => {
  it('refreshes until stopped and makes stop idempotent', async () => {
    vi.useFakeTimers();
    const replyWithChatAction = vi.fn().mockResolvedValue(true);
    const status = startTypingStatus({ replyWithChatAction } as never);

    expect(replyWithChatAction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(replyWithChatAction).toHaveBeenCalledTimes(2);

    status.stop();
    status.stop();
    await vi.advanceTimersByTimeAsync(8_000);

    expect(replyWithChatAction).toHaveBeenCalledTimes(2);
  });

  it('logs Telegram errors without rejecting the lifecycle', async () => {
    const typingError = new Error('Telegram unavailable');
    const replyWithChatAction = vi.fn().mockRejectedValue(typingError);
    const status = startTypingStatus({ replyWithChatAction } as never);

    await Promise.resolve();

    expect(loggerError).toHaveBeenCalledWith(
      { event: 'telegram.typing_failed', err: typingError },
      'Failed to update Telegram typing status',
    );
    status.stop();
  });
});
