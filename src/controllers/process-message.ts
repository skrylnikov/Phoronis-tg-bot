import { Context, } from 'telegraf';
import { pipe, intersection } from 'ramda';
import got from 'got';

import { processTextMessage } from './text-message/index.js';

export const processMessageController = async (ctx: Context) => {
  try {
    console.log('processMessageController');
    
    if (!ctx.from || !ctx.from.id || !ctx.chat || !ctx.chat.id || !ctx.message || ctx.message.forward_from) {
      return;
    }
    const message = ctx.message;
    
    const { text } = message;
    
    if (text) {
      await processTextMessage(ctx);
    }
  } catch (e) {
    console.error(e);
  }
}