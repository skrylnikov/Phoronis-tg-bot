export const Actions = {
  sendMessage: 'send message',
  sendMessageWithDelay: 'send message with delay',
  deleteMessage: 'delete message',
  restrictUser: 'restrict user',
} as const;

function createAction<Action extends string>(type: Action): {type: Action}
function createAction<Action extends string, Payload>(type: Action, payload: Payload): {type: Action, payload: Payload}
function createAction<Action extends string, Payload, Meta>(type: Action, payload: Payload, meta: Meta): {type: Action, payload: Payload, meta: Meta}
function createAction<Action extends string, Payload, Meta>(type: Action, payload?: Payload, meta?: Meta){
  return {
    type,
    payload,
    meta,
  }
}

interface IOptions {
  reply: boolean,
}

export const sendMessage = (message: string, options?: IOptions) => createAction(Actions.sendMessage, message, options);

export const sendMessageWithDelay = (message: string, delay: number) => createAction(Actions.sendMessageWithDelay, message, delay);

export const deleteMessage = (messageId: number) => createAction(Actions.deleteMessage, messageId);

export const restrictUser = (userId: number, delay: number) => createAction(Actions.restrictUser, userId, delay);

export type IActionTypes = 
  ReturnType<typeof sendMessage>
  | ReturnType<typeof sendMessageWithDelay>
  | ReturnType<typeof deleteMessage>
  | ReturnType<typeof restrictUser>
;