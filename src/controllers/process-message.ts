import { Context, } from 'telegraf';
import { pipe, intersection } from 'ramda';
import got from 'got';

import { activateWordList, openWeatherToken } from '../config';

import { processTextMessage } from './text-message';

export const processMessageController = async (ctx: Context) => {
  try {

    if (!ctx.from || !ctx.from.id || !ctx.chat || !ctx.chat.id || !ctx.message || ctx.message.forward_from) {
      return;
    }
    const message = ctx.message;
    
    const { text } = message;
    
    if (text) {
      processTextMessage(ctx);
    }
  } catch (e) {
    console.error(e);
  }
}