import type { Context } from 'grammy';

import { saveMessage } from '../domain';
import { findChatByIdRepo } from '../repositories';
import { logger } from '../logger';

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
  const chat = await findChatByIdRepo(BigInt(ctx.chat?.id ?? 0), {
    id: true,
    greeting: true,
    greetingEnabled: true,
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
    id: BigInt(reply.message_id),
    chatId: BigInt(ctx.chat.id),
    senderId: BigInt(reply.from?.id ?? 0),
    replyToMessageId: BigInt(messageId),
    sentAt: new Date(reply.date * 1000),
    messageType: 'TEXT',
    text: chat?.greeting ?? '',
  });
};
