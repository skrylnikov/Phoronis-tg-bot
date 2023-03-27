import { IExecuteProps } from './types.js';

import { sendMessage } from './actions.js';

export const config = {
  activateList: [
    ['расскажи', 'себе'],
    ['раскажи', 'себе'],
    ['что', 'умеешь'],
  ],
};

export const execute = async ({ }: IExecuteProps) => [
  sendMessage(`Привет, меня зовут ИО, но ты можешь называть меня Форонида :)
Я ещё совсем маленькая и только учусь.
Но у же сейчас я умею показывать погоду, просто напиши 'ио погода Санкт-Петербург'`, {reply: true}),
];
