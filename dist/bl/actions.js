export const Actions = {
    sendMessage: 'send message',
    sendMessageWithDelay: 'send message with delay',
    deleteMessage: 'delete message',
    restrictUser: 'restrict user',
};
function createAction(type, payload, meta) {
    return {
        type,
        payload,
        meta,
    };
}
export const sendMessage = (message, options) => createAction(Actions.sendMessage, message, options);
export const sendMessageWithDelay = (message, delay) => createAction(Actions.sendMessageWithDelay, message, delay);
export const deleteMessage = (messageId) => createAction(Actions.deleteMessage, messageId);
export const restrictUser = (userId, delay) => createAction(Actions.restrictUser, userId, delay);
