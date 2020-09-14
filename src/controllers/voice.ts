import { Context } from 'telegraf';
import got from 'got';
import ffmpeg from 'ffmpeg.js';

import { yandexCloudToken } from '../config';


interface IResult {
  result: string;
}

export const voiceController = async (ctx: Context) => {
  try {
    const info = ctx.message?.voice || ctx.message?.video_note;

    if(!info || !ctx.message){
      return;
    }


    const { duration, file_id, file_size = 0} = info;
    ctx.replyWithChatAction('typing')
    const fileLink = await ctx.tg.getFileLink(file_id);
      
    const rawFile = await got.get(fileLink, {responseType: 'buffer'});
    
    console.log(`start recognoze voice message ${Math.round(file_size/1024)}Kb ${duration}сек`);
    let file = rawFile.body;
    if(ctx.message.video_note){
      const result = ffmpeg({
        MEMFS: [{name: 'test.mp4', data: new Uint8Array(rawFile.body)}],
        arguments: ["-i", "test.mp4", "-vn", '-c:a', 'libopus', '-b:a', '128k', "output.ogg"],
      });
      file = Buffer.from(result.MEMFS[0].data);
    }

    if(file.length < 1024 * 1024 && duration < 30){
      const result = await got.post<IResult>('https://stt.api.cloud.yandex.net/speech/v1/stt:recognize', {
        body: file,
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
