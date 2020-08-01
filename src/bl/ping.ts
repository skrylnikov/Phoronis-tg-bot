import { IExecuteProps } from './types';
import { sendMessage, IActionTypes } from './actions';

export const config = {
  activateList: [['ping'], ['пинг']],
};

export const execute = async ({ }: IExecuteProps): Promise<IActionTypes[]> => ([
  sendMessage('понг', {reply: true}),
]);