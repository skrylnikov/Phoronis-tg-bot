
import Telegraf from 'telegraf';

import { token } from './config';
import {
  processMessageController,
  startController,
  newChatMembersController,
  meController,
  voiceController
} from './controllers';

const bot = new Telegraf(token);

bot.start(startController);
  
bot.command('/me', meController);

bot.on('voice', voiceController);

bot.on('new_chat_members', newChatMembersController);

bot.on('message', processMessageController);



bot.launch();

