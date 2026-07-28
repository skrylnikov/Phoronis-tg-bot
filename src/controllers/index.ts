import { Composer } from 'grammy';

import type { BotContext } from '../bot';
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

export const controllers = new Composer<BotContext>();

controllers.use(guestController);

controllers.command('start', startController);

controllers.command('me', meController);

controllers.command('private', privateController);

controllers.command('ask', askController);

controllers.command('subscribe', subscribeController);
controllers.command('limits', limitsController);
controllers.command('subscription', subscriptionStatusController);
controllers.command('terms', termsController);
controllers.command('paysupport', paymentSupportController);

controllers.callbackQuery(/^subscription:/, subscriptionCallbackController);
controllers.on('pre_checkout_query', preCheckoutController);
controllers.on(':successful_payment', successfulPaymentController);
controllers.on(':refunded_payment', refundedPaymentController);

controllers.use(featuresController);

controllers.on(':voice', voiceController);
controllers.on(':video_note', voiceController);

controllers.on(':new_chat_members', newChatMembersController);

controllers.use(processMessageController);
