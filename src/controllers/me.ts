import { Context } from 'telegraf';

export const meController = (ctx: Context) => {
  try {
    
    if(ctx.message?.text && ctx.from){
      const text = ctx.message.text.replace('/me', '').trim();
      
      const username = `[${ctx.from.first_name || ctx.from.last_name || ctx.from.username || 'Неопознаный космонавт'}](tg://user?id=${ctx.from.id})`
      
      ctx.reply(`${username} *${text}*`, { parse_mode: 'MarkdownV2'});
      ctx.deleteMessage(ctx.message.message_id);
    }
    
  } catch (e) {
    console.error(e);
  }
}
