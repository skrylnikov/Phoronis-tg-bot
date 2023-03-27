import { IExecuteProps } from './types.js';
import { sendMessage, IActionTypes } from './actions.js';

export const config = {
  activateList: [['ping'], ['пинг']],
};

export const execute = async ({ }: IExecuteProps): Promise<IActionTypes[]> => ([
  sendMessage('понг', {reply: true}),
]);