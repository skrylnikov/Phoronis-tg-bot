import { Context } from 'telegraf';
import got from 'got';
import ffmpeg from 'ffmpeg.js';
import AWS from 'aws-sdk';

import { yandexCloudToken, yandexS3ID, yandexS3Secret } from '../config';


interface IResult {
  result: string;
}

const s3 = new AWS.S3({
  endpoint: 'https://storage.yandexcloud.net',
  accessKeyId: yandexS3ID,
  secretAccessKey: yandexS3Secret,
  region: 'us-east-1',
  httpOptions: {
    timeout: 10000,
    connectTimeout: 10000
  }
});

interface Check {
  id: string;
  done: boolean;
  response: {
    chunks: any;
  }
}

export const voiceController = async (ctx: Context) => {
  try {
    const info = ctx.message?.voice || ctx.message?.video_note;

    if (!info || !ctx.message) {
      return;
    }


    const { duration, file_id, file_size = 0 } = info;
    ctx.replyWithChatAction('typing')
    const fileLink = await ctx.tg.getFileLink(file_id);

    const rawFile = await got.get(fileLink, { responseType: 'buffer' });

    console.log(`start recognoze voice message ${Math.round(file_size / 1024)}Kb ${duration}сек`);
    let file = rawFile.body;
    if (ctx.message.video_note) {
      const result = ffmpeg({
        MEMFS: [{ name: 'test.mp4', data: new Uint8Array(rawFile.body) }],
        arguments: ["-i", "test.mp4", "-vn", '-c:a', 'libopus', '-b:a', '128k', "output.ogg"],
      });
      file = Buffer.from(result.MEMFS[0].data);
    }

    if (file.length < 1024 * 1024 && duration < 30) {
      const result = await got.post<IResult>('https://stt.api.cloud.yandex.net/speech/v1/stt:recognize', {
        body: file,
        headers: {
          'Authorization': `Api-Key ${yandexCloudToken}`
        },
        responseType: 'json',
      });

      console.log(`recognize voice result: ${result.body.result}`);

      ctx.reply(result.body.result, { reply_to_message_id: ctx.message.message_id });
    } else {
      const uploadResult: AWS.S3.ManagedUpload.SendData = await new Promise(function (resolve, reject) {
        s3.upload({
          Bucket: 'bot-voic',
          Key: 'phoronis/' + file_id,
          Body: file,
        }, (err, data) => {
          if (err) return reject(err);
          return resolve(data);
        });
      });
      
      const task = await got.post<Check>('https://transcribe.api.cloud.yandex.net/speech/stt/v2/longRunningRecognize', {
        json: {
          config: {
            specification: {
              languageCode: 'ru-RU',
            }
          },
          audio: {
            uri: uploadResult.Location,
          }
        },
        headers: {
          'Authorization': `Api-Key ${yandexCloudToken}`
        },
        responseType: 'json',
      });

      const id = task.body.id;

      let result = task.body;
      let counter = 0;
      while(!result.done){
        const {body} = await got.get<Check>(`https://operation.api.cloud.yandex.net/operations/${id}`, {
          headers: {
            'Authorization': `Api-Key ${yandexCloudToken}`
          },
          responseType: 'json',
        });

        result = body;
        
        await new Promise((res) => setTimeout(res, 1000));
        if(counter++ > 300){
          break;
        }
      }

      const text = result?.response?.chunks?.map(({alternatives}: any) => alternatives?.[0]?.text).join('  ')

      if(!text){
        console.error(result);
        ctx.reply('Не получилось распознать этот войс :(', { reply_to_message_id: ctx.message.message_id });
      } else {
        console.log(`recognize voice result: ${text}`);
        ctx.reply(text, { reply_to_message_id: ctx.message.message_id });
      }
    }

  } catch (e) {
    console.error(e);
  }
};
