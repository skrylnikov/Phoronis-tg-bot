import type { BotContext } from '../bot';
import { logger } from '../logger';

const refreshIntervalMs = 4_000;

export interface TypingStatus {
  stop(): void;
}

export function startTypingStatus(ctx: BotContext): TypingStatus {
  let stopped = false;

  const sendTyping = () => {
    if (stopped) return;

    void ctx.replyWithChatAction('typing').catch((error) => {
      logger.error(
        { event: 'telegram.typing_failed', err: error },
        'Failed to update Telegram typing status',
      );
    });
  };

  sendTyping();
  const interval = setInterval(sendTyping, refreshIntervalMs);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
    },
  };
}
