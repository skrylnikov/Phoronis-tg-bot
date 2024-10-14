import { Context } from 'grammy';

export const meController = (ctx: Context) => {
  try {
    
    if(ctx.message?.text && ctx.from){
      const text = ctx.message.text.replace('/me', '').trim();
      
      const username = `[${ctx.from.first_name || ctx.from.last_name || ctx.from.username || 'Неопознаный юзер'}](tg://user?id=${ctx.from.id})`
      const result = `${username} *${text}*`;

      ctx.reply(result, { parse_mode: 'Markdown'});
      ctx.api.deleteMessage(ctx.message.chat.id, ctx.message.message_id);
    }
    
  } catch (e) {
    console.error(e);
  }
}
