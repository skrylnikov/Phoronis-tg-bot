import { InputFile } from 'grammy';
import type { BotContext } from '../bot';
import { logger } from '../logger';
import {
  createRichMessage,
  createRichMessageIfNeeded,
  maxRichMessageLength,
  requiresRichMarkdown,
  sendWithRichFallback,
  toMarkdownV2,
} from './rich-message';

const maxLegacyMessageLength = 4096;
const thinkingText = 'Думаю…';

function isMessageNotModified(error: unknown): boolean {
  const description =
    typeof error === 'object' &&
    error !== null &&
    'description' in error &&
    typeof error.description === 'string'
      ? error.description
      : error instanceof Error
        ? error.message
        : '';

  return description.toLowerCase().includes('message is not modified');
}

export interface StreamedReply {
  message_id: number;
  date: number;
  ephemeral_message_id?: number;
  receiver_user?: {
    id: number;
  };
  from?: {
    id: number;
  };
}

interface TelegramStreamOptions {
  intervalMs?: number;
  ephemeralReceiverUserId?: number;
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
    private groupMessage: StreamedReply | undefined,
    private readonly intervalMs: number,
    private readonly ephemeralReceiverUserId: number | undefined,
  ) {}

  static async create(
    ctx: BotContext,
    options: TelegramStreamOptions = {},
  ): Promise<TelegramStreamSink> {
    const intervalMs = options.intervalMs ?? 1000;
    const ephemeralReceiverUserId = options.ephemeralReceiverUserId;

    if (ctx.chat?.type === 'private' || !ephemeralReceiverUserId) {
      return new TelegramStreamSink(ctx, undefined, intervalMs, undefined);
    }

    const sink = new TelegramStreamSink(
      ctx,
      undefined,
      intervalMs,
      ephemeralReceiverUserId,
    );
    try {
      const message = ephemeralReceiverUserId
        ? await ctx.reply(thinkingText, {
            receiver_user_id: ephemeralReceiverUserId,
            ...(ctx.msg?.ephemeral_message_id
              ? {
                  reply_parameters: {
                    ephemeral_message_id: ctx.msg.ephemeral_message_id,
                  },
                }
              : {}),
            ...sink.threadOptions(),
          })
        : await ctx.reply(thinkingText, {
            reply_parameters: {
              message_id: ctx.msg?.message_id,
            },
            ...sink.threadOptions(),
          });
      if (ephemeralReceiverUserId && !message.ephemeral_message_id) {
        throw new Error('Telegram did not return an ephemeral message ID');
      }
      return new TelegramStreamSink(
        ctx,
        message,
        intervalMs,
        ephemeralReceiverUserId,
      );
    } catch (error) {
      logger.error(
        { event: 'telegram.stream_placeholder_failed', err: error },
        'Failed to create streaming placeholder',
      );
      if (ephemeralReceiverUserId) {
        throw error;
      }
      sink.active = false;
      return sink;
    }
  }

  update(text: string): void {
    if (!this.active || this.finalizing || !text) {
      return;
    }

    const preview = text.slice(
      0,
      this.ephemeralReceiverUserId
        ? maxLegacyMessageLength
        : requiresRichMarkdown(text)
          ? maxRichMessageLength
          : maxLegacyMessageLength,
    );
    if (preview === this.lastPublishedText) {
      return;
    }

    this.pendingText = preview;
    if (this.publishTimer || this.publishing) {
      return;
    }

    if (!this.lastPublishedText && !this.groupMessage) {
      void this.flushPending();
    } else {
      this.schedulePending();
    }
  }

  async finish(rawText: string): Promise<StreamedReply> {
    this.finalizing = true;
    this.clearPending();
    await this.publishPromise;

    if (
      this.ephemeralReceiverUserId &&
      toMarkdownV2(rawText).length > maxLegacyMessageLength
    ) {
      throw new Error('Ephemeral response exceeds Telegram message limit');
    }

    if (rawText.length > maxRichMessageLength) {
      return this.sendTextDocument(rawText);
    }

    if (this.ctx.chat?.type === 'private' || !this.groupMessage) {
      return this.sendFinalReply(rawText);
    }

    const chatId = this.ctx.chatId;
    if (!chatId) {
      return this.sendFinalReply(rawText);
    }

    if (this.ephemeralReceiverUserId) {
      return this.finishEphemeral(rawText);
    }

    if (rawText === this.lastPublishedText) {
      return this.groupMessage;
    }

    const richMessage = this.finalRichMessage(rawText);
    if (richMessage) {
      try {
        await this.ctx.api.editMessageText(
          chatId,
          this.groupMessage.message_id,
          richMessage,
        );
        return this.groupMessage;
      } catch (error) {
        if (isMessageNotModified(error)) {
          return this.groupMessage;
        }
        logger.error(
          { event: 'telegram.stream_rich_finalize_failed', err: error },
          'Failed to finalize rich stream',
        );
      }
    }

    if (toMarkdownV2(rawText).length > maxLegacyMessageLength) {
      return this.sendTextDocument(rawText);
    }

    return this.finishGroupWithLegacyFallback(chatId, rawText);
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
      if (
        this.ephemeralReceiverUserId &&
        this.groupMessage.ephemeral_message_id
      ) {
        await this.ctx.api.deleteEphemeralMessage(
          chatId,
          this.ephemeralReceiverUserId,
          this.groupMessage.ephemeral_message_id,
        );
      } else {
        await this.ctx.api.deleteMessage(chatId, this.groupMessage.message_id);
      }
    } catch (error) {
      logger.error(
        { event: 'telegram.stream_placeholder_remove_failed', err: error },
        'Failed to remove streaming placeholder',
      );
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
          const richMessage = createRichMessageIfNeeded(text);
          if (richMessage) {
            await this.ctx.replyWithRichMessageDraft(
              richMessage,
              this.draftOptions(),
            );
          } else {
            await this.ctx.replyWithDraft(toMarkdownV2(text), {
              ...this.draftOptions(),
              parse_mode: 'MarkdownV2',
            });
          }
        } else if (this.ctx.chatId) {
          if (!this.groupMessage) {
            this.groupMessage = await this.sendInitialGroupReply(text);
          } else {
            if (
              this.ephemeralReceiverUserId &&
              this.groupMessage.ephemeral_message_id
            ) {
              await this.ctx.api.editEphemeralMessageText(
                this.ctx.chatId,
                this.ephemeralReceiverUserId,
                this.groupMessage.ephemeral_message_id,
                text,
              );
            } else {
              const richMessage = createRichMessageIfNeeded(text);
              if (richMessage) {
                await this.ctx.api.editMessageText(
                  this.ctx.chatId,
                  this.groupMessage.message_id,
                  richMessage,
                );
              } else {
                await this.ctx.api.editMessageText(
                  this.ctx.chatId,
                  this.groupMessage.message_id,
                  toMarkdownV2(text),
                  { parse_mode: 'MarkdownV2' },
                );
              }
            }
          }
        }
        this.lastPublishedText = text;
        this.lastPublishedAt = Date.now();
      } catch (error) {
        if (this.ephemeralReceiverUserId) {
          this.active = false;
        }
        this.lastPublishedAt = Date.now();
        logger.error(
          { event: 'telegram.stream_update_failed', err: error },
          'Failed to publish Telegram stream update',
        );
      }
    })();
    await this.publishPromise;
    this.publishing = false;

    if (this.pendingText && !this.finalizing) {
      this.schedulePending();
    }
  }

  private sendInitialGroupReply(text: string): Promise<StreamedReply> {
    const options = {
      reply_parameters: {
        message_id: this.ctx.msg?.message_id,
      },
      ...this.threadOptions(),
    };

    return sendWithRichFallback(
      text,
      (richMessage) => this.ctx.replyWithRichMessage(richMessage, options),
      (markdown) =>
        this.ctx.reply(markdown, {
          ...options,
          parse_mode: 'MarkdownV2',
        }),
      (plainText) => this.ctx.reply(plainText, options),
    );
  }

  private clearPending(): void {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
    }
    this.pendingText = undefined;
  }

  private async sendFinalReply(rawText: string): Promise<StreamedReply> {
    if (rawText.length > maxRichMessageLength) {
      return this.sendTextDocument(rawText);
    }

    const richMessage = this.finalRichMessage(rawText);
    if (richMessage) {
      try {
        return await this.ctx.replyWithRichMessage(richMessage, {
          reply_parameters: {
            message_id: this.ctx.msg?.message_id,
          },
          ...this.threadOptions(),
        });
      } catch (error) {
        logger.error(
          { event: 'telegram.rich_reply_failed', err: error },
          'Failed to send final rich reply',
        );
        if (toMarkdownV2(rawText).length > maxLegacyMessageLength) {
          return this.sendTextDocument(rawText);
        }
      }
    }

    try {
      return await this.ctx.reply(toMarkdownV2(rawText), {
        reply_to_message_id: this.ctx.msg?.message_id,
        parse_mode: 'MarkdownV2',
        ...this.threadOptions(),
      });
    } catch (error) {
      logger.error(
        { event: 'telegram.markdown_reply_failed', err: error },
        'Failed to send final MarkdownV2 reply',
      );
      return this.ctx.reply(rawText, {
        reply_to_message_id: this.ctx.msg?.message_id,
        ...this.threadOptions(),
      });
    }
  }

  private async finishEphemeral(rawText: string): Promise<StreamedReply> {
    const chatId = this.ctx.chatId;
    const groupMessage = this.groupMessage;
    const ephemeralMessageId = groupMessage?.ephemeral_message_id;
    if (!chatId || !this.ephemeralReceiverUserId || !ephemeralMessageId) {
      throw new Error('Missing ephemeral message target');
    }

    try {
      await this.ctx.api.editEphemeralMessageText(
        chatId,
        this.ephemeralReceiverUserId,
        ephemeralMessageId,
        toMarkdownV2(rawText),
        { parse_mode: 'MarkdownV2' },
      );
    } catch (formattedError) {
      if (isMessageNotModified(formattedError)) {
        return groupMessage;
      }
      logger.error(
        {
          event: 'telegram.ephemeral_stream_finalize_failed',
          err: formattedError,
        },
        'Failed to finalize formatted ephemeral stream',
      );
      try {
        await this.ctx.api.editEphemeralMessageText(
          chatId,
          this.ephemeralReceiverUserId,
          ephemeralMessageId,
          rawText,
        );
      } catch (plainTextError) {
        if (!isMessageNotModified(plainTextError)) {
          throw plainTextError;
        }
      }
    }

    return groupMessage;
  }

  private async finishGroupWithLegacyFallback(
    chatId: number,
    rawText: string,
  ): Promise<StreamedReply> {
    const groupMessage = this.groupMessage;
    if (!groupMessage) {
      return this.sendFinalReply(rawText);
    }

    try {
      await this.ctx.api.editMessageText(
        chatId,
        groupMessage.message_id,
        toMarkdownV2(rawText),
        { parse_mode: 'MarkdownV2' },
      );
      return groupMessage;
    } catch (markdownError) {
      if (isMessageNotModified(markdownError)) {
        return groupMessage;
      }
      logger.error(
        {
          event: 'telegram.markdown_stream_finalize_failed',
          err: markdownError,
        },
        'Failed to finalize MarkdownV2 stream',
      );
      try {
        await this.ctx.api.editMessageText(
          chatId,
          groupMessage.message_id,
          rawText,
        );
        return groupMessage;
      } catch (plainTextError) {
        if (isMessageNotModified(plainTextError)) {
          return groupMessage;
        }
        logger.error(
          {
            event: 'telegram.plain_stream_finalize_failed',
            err: plainTextError,
          },
          'Failed to finalize plain text stream',
        );
        return this.sendFinalReply(rawText);
      }
    }
  }

  private finalRichMessage(text: string): { markdown: string } | undefined {
    return toMarkdownV2(text).length > maxLegacyMessageLength
      ? createRichMessage(text)
      : createRichMessageIfNeeded(text);
  }

  private async sendTextDocument(text: string): Promise<StreamedReply> {
    const result = await this.ctx.replyWithDocument(
      new InputFile(Buffer.from(text, 'utf8'), 'answer.txt'),
      {
        caption: 'Ответ слишком длинный — полный текст в файле.',
        reply_parameters: { message_id: this.ctx.msg?.message_id },
        ...this.threadOptions(),
      },
    );

    if (this.groupMessage && this.ctx.chatId) {
      try {
        await this.ctx.api.deleteMessage(
          this.ctx.chatId,
          this.groupMessage.message_id,
        );
      } catch (error) {
        logger.error(
          { event: 'telegram.stream_placeholder_remove_failed', err: error },
          'Failed to remove streaming placeholder',
        );
      }
    }

    return result;
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
