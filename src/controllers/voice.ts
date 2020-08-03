import { Context } from 'telegraf';
import got from 'got';

import { yandexCloudToken } from '../config';


interface IResult {
  result: string;
}

export const voiceController = async (ctx: Context) => {
  try {
    if(!ctx.message?.voice){
      return;
    }

    const { duration, file_id, file_size = 0} = ctx.message.voice;
    ctx.replyWithChatAction('typing')
    if(file_size < 1024 * 1024 && duration< 30){

      
      const fileLink = await ctx.tg.getFileLink(file_id);
      
      const file = await got.get(fileLink, {responseType: 'buffer'});
      
      console.log(`start recognoze voice message ${Math.round(file_size/1024)}Kb ${duration}сек`);
      
      const result = await got.post<IResult>('https://stt.api.cloud.yandex.net/speech/v1/stt:recognize', {
        body: file.body,
        headers: {
          'Authorization': `Api-Key ${yandexCloudToken}`
        },
        responseType: 'json',
      });
      
      console.log(`recognize voice result: ${result.body.result}`);
      
      ctx.reply(result.body.result, { reply_to_message_id: ctx.message.message_id});
    } else {
      console.warn('Слишком длинный войс')

      ctx.reply('Кажется это очень длинный войс. Я пока что не умею их распозновать :(', { reply_to_message_id: ctx.message.message_id});
    }
    
  } catch (e) {
    console.error(e);
  }
};
