import { Context } from 'telegraf';
import { pipe, intersection, without, flatten } from 'ramda';
import { PorterStemmerRu } from 'natural';

import { Language } from '../../tools';

import { activateWordList } from '../../config';

import * as Weather from './weather';
import * as About from './about';

const rawConfig = [Weather, About];

const executorList = rawConfig.map((c) => ({
  ...c,
  config: {
    ...c.config,
    activateTokenList: c.config.activateList.map((x) => x.map(PorterStemmerRu.stem)),
  },
}));

console.log(executorList);



export const processTextMessage = async (ctx: Context) => {
  const text = ctx.message?.text;

  if(!text){
    return;
  }

  const tokenList = pipe(
    Language.clean,
    Language.tokenize,
    Language.findActivate(activateWordList),
  )(text);

  if(!tokenList || tokenList.length === 0){
    return;
  }

  const normalizedTokenList = tokenList.map(PorterStemmerRu.stem);

  console.log(normalizedTokenList);
  
  const comand = executorList.find((x) => x.config.activateTokenList.some((x) => x.every((y) => normalizedTokenList.includes(y))));

  if(!comand){
    ctx.reply('Я тут', { reply_to_message_id: ctx.message?.message_id });
    return;
  }

  const [result] = await Promise.all([
    comand.execute({
      tokenList,
      normalizedTokenList: without(flatten(comand.config.activateTokenList), normalizedTokenList),
    }),
    ctx.replyWithChatAction('typing'),
  ]);

  ctx.reply(result, { reply_to_message_id: ctx.message?.message_id, parse_mode: 'Markdown', });

};