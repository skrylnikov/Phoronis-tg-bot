
import { Context } from 'telegraf';

export const newChatMembersController = (ctx: Context) => ctx.reply('Если ты тут, значит ты решил быть ближе к звездам. Располагайся поудобней🥳', { reply_to_message_id: ctx.message?.message_id});
