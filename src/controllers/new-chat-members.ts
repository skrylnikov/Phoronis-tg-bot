import type { Context } from 'grammy';

import { prisma } from '../db';
import { logger } from '../logger';
import { saveMessage } from '../domain';

export const newChatMembersDelayMs = 3000;

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const isCurrentMember = (
  member: Awaited<ReturnType<Context['getChatMember']>>,
) =>
  member.status === 'creator' ||
  member.status === 'administrator' ||
  member.status === 'member' ||
  (member.status === 'restricted' && member.is_member);

export const newChatMembersController = async (ctx: Context) => {
  const chat = await prisma.chat.findUnique({
    where: {
      id: ctx.chat?.id,
    },
  });

  const message = ctx.message;
  const newMembers = message?.new_chat_members;
  const messageId = message?.message_id;

  if (!chat?.greeting || !ctx.chat || !newMembers?.length || !messageId) {
    return;
  }

  await delay(newChatMembersDelayMs);

  try {
    const memberStatuses = await Promise.all(
      newMembers.map((member) => ctx.getChatMember(member.id)),
    );

    if (!memberStatuses.some(isCurrentMember)) {
      return;
    }
  } catch (error) {
    logger.warn(
      {
        err: error,
        chatId: ctx.chat.id,
        event: 'chat_member.greeting_check_failed',
      },
      'Failed to check new chat member status before greeting',
    );
    return;
  }

  const reply = await ctx.reply(chat.greeting, {
    reply_to_message_id: messageId,
  });
  await saveMessage({
    id: reply.message_id,
    chatId: ctx.chat.id,
    senderId: reply.from?.id ?? 0,
    replyToMessageId: messageId,
    sentAt: new Date(reply.date * 1000),
    messageType: 'TEXT',
    text: chat.greeting,
  });
};
