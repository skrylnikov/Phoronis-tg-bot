import { Composer } from 'grammy';

import type { BotContext } from '../bot';
import { logger, telegramLogContext, withLogContext } from '../logger';
import { analyticsController } from './analytics';
import { askController } from './ask.js';
import { featuresController } from './features';
import { guestController } from './guest.js';
import { meController } from './me.js';
import { newChatMembersController } from './new-chat-members.js';
import { privateController } from './private.js';
import { processMessageController } from './process-message.js';
import { startController } from './start.js';
import {
  limitsController,
  paymentSupportController,
  preCheckoutController,
  refundedPaymentController,
  subscribeController,
  subscriptionCallbackController,
  subscriptionStatusController,
  successfulPaymentController,
  termsController,
} from './subscription.js';
import { voiceController } from './voice.js';
import { whatsNewCallbackController, whatsNewController } from './whats-new.js';

export const controllers = new Composer<BotContext>();

controllers.use(async (ctx, next) => {
  const context = telegramLogContext(ctx);
  const startedAt = Date.now();
  const log = logger.child(context);

  log.info({ event: 'update.received' }, 'Telegram update received');
  try {
    await withLogContext(context, next);
    log.info(
      { event: 'update.completed', durationMs: Date.now() - startedAt },
      'Telegram update completed',
    );
  } catch (err) {
    log.error(
      {
        event: 'update.failed',
        durationMs: Date.now() - startedAt,
        err,
      },
      'Telegram update failed',
    );
    throw err;
  }
});

controllers.use(guestController);

controllers.command('start', startController);

controllers.command('me', meController);

controllers.command('private', privateController);

controllers.command('ask', askController);
controllers.command('analytics', analyticsController);

controllers.command('subscribe', subscribeController);
controllers.command('limits', limitsController);
controllers.command('subscription', subscriptionStatusController);
controllers.command('terms', termsController);
controllers.command('paysupport', paymentSupportController);
controllers.command('whatsnew', whatsNewController);

controllers.callbackQuery(/^subscription:/, subscriptionCallbackController);
controllers.callbackQuery(/^whatsnew:/, whatsNewCallbackController);
controllers.on('pre_checkout_query', preCheckoutController);
controllers.on(':successful_payment', successfulPaymentController);
controllers.on(':refunded_payment', refundedPaymentController);

controllers.use(featuresController);

controllers.on(':voice', voiceController);
controllers.on(':video_note', voiceController);

controllers.on(':new_chat_members', newChatMembersController);

controllers.use(processMessageController);
