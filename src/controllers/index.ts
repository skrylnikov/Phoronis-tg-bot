import { Composer } from 'grammy';

import type { BotContext } from '../bot';
import { featuresController } from './features';
import { meController } from './me.js';
import { newChatMembersController } from './new-chat-members.js';
import { processMessageController } from './process-message.js';
import { startController } from './start.js';
import { voiceController } from './voice.js';

export const controllers = new Composer<BotContext>();

controllers.command('start', startController);

controllers.command('me', meController);

controllers.use(featuresController);

controllers.on(':voice', voiceController);
controllers.on(':video_note', voiceController);

controllers.on(':new_chat_members', newChatMembersController);

controllers.use(processMessageController);
