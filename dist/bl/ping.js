import { sendMessage } from './actions.js';
export const config = {
    activateList: [['ping'], ['пинг']],
};
export const execute = async ({}) => ([
    sendMessage('понг', { reply: true }),
]);
