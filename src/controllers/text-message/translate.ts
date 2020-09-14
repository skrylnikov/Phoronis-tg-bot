import got from 'got';

import { sendMessage } from '../../bl/actions';

import { yandexCloudToken } from '../../config';

import { IExecuteProps } from './types';


export const config = {
  activateList: [['перевод'], ['переведи'], ['по', 'русски'], ['на', 'русском']],
};

interface ITranslate {
  detectedLanguageCode: string;
  text: string;
}
interface ITranslateResult {
  translations: ITranslate[];
}

export const execute = async ({ normalizedTokenList, ctx }: IExecuteProps) => {

  const replyMessage = ctx.message?.reply_to_message;
  
  const replyText = replyMessage?.text || replyMessage?.caption;

  if(!replyText){
    return [];
  }

  const result = await got.post<ITranslateResult>('https://translate.api.cloud.yandex.net/translate/v2/translate', {
    json: {
      texts: [replyText],
      targetLanguageCode: 'ru',
    }, 
    headers: {
      'Authorization': `Api-Key ${yandexCloudToken}`
    },
    responseType: 'json',
  });
  
  const translate = result.body.translations[0];

  if(translate.detectedLanguageCode === 'ru') {
    return [
      sendMessage(`Но ведь это сообщение и так написанно на русском языке`, { reply: true}),
    ];
  }
  
  ctx.reply(translate.text, { reply_to_message_id: replyMessage?.message_id});

  return [];
}