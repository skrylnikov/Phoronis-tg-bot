
import Telegraf from 'telegraf';

import { token } from './config';
import { processMessageController, startController } from './controllers';

const bot = new Telegraf(token);

bot.start(startController);


bot.on('message', processMessageController);


bot.launch();

