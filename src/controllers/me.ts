import { Context } from 'grammy';

import { prisma } from '../db';

export const meController = async (ctx: Context) => {
  try {
    
    if(ctx.message?.text && ctx.from){
      const text = ctx.message.text.replace('/me', '').trim();
      
      const username = `[${ctx.from.first_name || ctx.from.last_name || ctx.from.username || 'Неопознаный юзер'}](tg://user?id=${ctx.from.id})`
      const result = `${username} *${text}*`;

      const reply = await ctx.reply(result, { parse_mode: 'Markdown'});
      await ctx.api.deleteMessage(ctx.message.chat.id, ctx.message.message_id);

      await prisma.message.create({
        data: {
          id: reply.message_id,
          chatId: ctx.chatId!,
          senderId: reply.from!.id,
          sentAt: new Date(reply.date * 1000),
          messageType: "TEXT",
          text: result,
        },
      });
    }
    
  } catch (e) {
    console.error(e);
  }
}
