import type { BotContext } from '../bot';
import { logger } from '../logger';

const maxPreviewLength = 4096;
const thinkingText = 'Думаю…';

export interface StreamedReply {
  message_id: number;
  date: number;
  from?: {
    id: number;
  };
}

interface TelegramStreamOptions {
  intervalMs?: number;
}

export class TelegramStreamSink {
  private active = true;
  private lastPublishedAt = Date.now();
  private lastPublishedText = '';
  private pendingText: string | undefined;
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private publishPromise = Promise.resolve();
  private publishing = false;
  private finalizing = false;

  private constructor(
    private readonly ctx: BotContext,
    private readonly groupMessage: StreamedReply | undefined,
    private readonly intervalMs: number,
  ) {}

  static async create(
    ctx: BotContext,
    options: TelegramStreamOptions = {},
  ): Promise<TelegramStreamSink> {
    const intervalMs = options.intervalMs ?? 1000;

    if (ctx.chat?.type === 'private') {
      const sink = new TelegramStreamSink(ctx, undefined, intervalMs);
      try {
        await ctx.replyWithDraft('', sink.draftOptions());
        sink.lastPublishedAt = Date.now();
      } catch (error) {
        sink.active = false;
        logger.error(error, 'Failed to create Telegram message draft');
      }
      return sink;
    }

    const sink = new TelegramStreamSink(ctx, undefined, intervalMs);
    try {
      const message = await ctx.reply(thinkingText, {
        reply_to_message_id: ctx.msg?.message_id,
        ...sink.threadOptions(),
      });
      return new TelegramStreamSink(ctx, message, intervalMs);
    } catch (error) {
      logger.error(error, 'Failed to create streaming placeholder');
      sink.active = false;
      return sink;
    }
  }

  update(text: string): void {
    if (!this.active || this.finalizing || !text) {
      return;
    }

    const preview = text.slice(0, maxPreviewLength);
    if (preview === this.lastPublishedText) {
      return;
    }

    this.pendingText = preview;
    if (this.publishTimer || this.publishing) {
      return;
    }

    this.schedulePending();
  }

  async finish(rawText: string, formattedText: string): Promise<StreamedReply> {
    this.finalizing = true;
    this.clearPending();
    await this.publishPromise;

    if (this.ctx.chat?.type === 'private' || !this.groupMessage) {
      return this.sendFinalReply(formattedText);
    }

    const chatId = this.ctx.chatId;
    if (!chatId) {
      return this.sendFinalReply(formattedText);
    }

    try {
      await this.ctx.api.editMessageText(
        chatId,
        this.groupMessage.message_id,
        formattedText,
        { parse_mode: 'MarkdownV2' },
      );
      return this.groupMessage;
    } catch (formattedError) {
      logger.error(formattedError, 'Failed to finalize formatted stream');
      try {
        await this.ctx.api.editMessageText(
          chatId,
          this.groupMessage.message_id,
          rawText,
        );
        return this.groupMessage;
      } catch (plainTextError) {
        logger.error(plainTextError, 'Failed to finalize plain text stream');
        return this.sendFinalReply(formattedText);
      }
    }
  }

  async cancel(): Promise<void> {
    this.finalizing = true;
    this.clearPending();
    await this.publishPromise;

    if (this.ctx.chat?.type === 'private' || !this.groupMessage) {
      return;
    }

    const chatId = this.ctx.chatId;
    if (!chatId) {
      return;
    }

    try {
      await this.ctx.api.deleteMessage(chatId, this.groupMessage.message_id);
    } catch (error) {
      logger.error(error, 'Failed to remove streaming placeholder');
    }
  }

  private schedulePending(): void {
    const delay = Math.max(
      0,
      this.intervalMs - (Date.now() - this.lastPublishedAt),
    );
    this.publishTimer = setTimeout(() => {
      void this.flushPending();
    }, delay);
  }

  private async flushPending(): Promise<void> {
    this.publishTimer = undefined;
    const text = this.pendingText;
    this.pendingText = undefined;

    if (
      !this.active ||
      this.finalizing ||
      this.publishing ||
      !text ||
      text === this.lastPublishedText
    ) {
      return;
    }

    this.publishing = true;
    this.publishPromise = (async () => {
      try {
        if (this.ctx.chat?.type === 'private') {
          await this.ctx.replyWithDraft(text, this.draftOptions());
        } else if (this.ctx.chatId && this.groupMessage) {
          await this.ctx.api.editMessageText(
            this.ctx.chatId,
            this.groupMessage.message_id,
            text,
          );
        }
        this.lastPublishedText = text;
        this.lastPublishedAt = Date.now();
      } catch (error) {
        this.active = false;
        logger.error(error, 'Failed to publish Telegram stream update');
      }
    })();
    await this.publishPromise;
    this.publishing = false;

    if (this.pendingText && !this.finalizing) {
      this.schedulePending();
    }
  }

  private clearPending(): void {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
    }
    this.pendingText = undefined;
  }

  private sendFinalReply(formattedText: string): Promise<StreamedReply> {
    return this.ctx.reply(formattedText, {
      reply_to_message_id: this.ctx.msg?.message_id,
      parse_mode: 'MarkdownV2',
      ...this.threadOptions(),
    });
  }

  private threadOptions(): { message_thread_id?: number } {
    return this.ctx.msg?.is_topic_message
      ? { message_thread_id: this.ctx.msg.message_thread_id }
      : {};
  }

  private draftOptions(): {
    draft_id: number;
    message_thread_id?: number;
  } {
    return {
      draft_id: this.ctx.update.update_id,
      ...this.threadOptions(),
    };
  }
}
