import type { Context } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma, saveMessage, warn } = vi.hoisted(() => ({
  prisma: {
    chat: { findUnique: vi.fn() },
  },
  saveMessage: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../db', () => ({ prisma }));
vi.mock('../logger', () => ({ logger: { warn } }));
vi.mock('../shared', () => ({ saveMessage }));

import {
  newChatMembersController,
  newChatMembersDelayMs,
} from '../controllers/new-chat-members';

function createContext(memberIds = [123]) {
  const reply = vi.fn().mockResolvedValue({
    message_id: 2,
    from: { id: 999 },
    date: 1,
  });
  const getChatMember = vi.fn();

  return {
    context: {
      chat: { id: -1001, type: 'supergroup' },
      message: {
        message_id: 1,
        new_chat_members: memberIds.map((id) => ({ id })),
      },
      getChatMember,
      reply,
    } as unknown as Context,
    getChatMember,
    reply,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  prisma.chat.findUnique.mockResolvedValue({ greeting: 'Добро пожаловать!' });
  saveMessage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('new chat members greeting', () => {
  it('waits before checking membership and sending the greeting', async () => {
    const { context, getChatMember, reply } = createContext();
    getChatMember.mockResolvedValue({ status: 'member' });

    const pending = newChatMembersController(context);
    await vi.advanceTimersByTimeAsync(newChatMembersDelayMs - 1);

    expect(getChatMember).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(getChatMember).toHaveBeenCalledWith(123);
    expect(reply).toHaveBeenCalledWith('Добро пожаловать!', {
      reply_to_message_id: 1,
    });
    expect(saveMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ['left', { status: 'left' }],
    ['kicked', { status: 'kicked' }],
    [
      'restricted without membership',
      { status: 'restricted', is_member: false },
    ],
  ])('does not greet a user with status %s', async (_label, status) => {
    const { context, getChatMember, reply } = createContext();
    getChatMember.mockResolvedValue(status);

    const pending = newChatMembersController(context);
    await vi.advanceTimersByTimeAsync(newChatMembersDelayMs);
    await pending;

    expect(reply).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('greets when at least one user remains in a batch', async () => {
    const { context, getChatMember, reply } = createContext([123, 456]);
    getChatMember
      .mockResolvedValueOnce({ status: 'kicked' })
      .mockResolvedValueOnce({ status: 'member' });

    const pending = newChatMembersController(context);
    await vi.advanceTimersByTimeAsync(newChatMembersDelayMs);
    await pending;

    expect(getChatMember).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledOnce();
  });

  it('greets a restricted user who is still a member', async () => {
    const { context, getChatMember, reply } = createContext();
    getChatMember.mockResolvedValue({ status: 'restricted', is_member: true });

    const pending = newChatMembersController(context);
    await vi.advanceTimersByTimeAsync(newChatMembersDelayMs);
    await pending;

    expect(reply).toHaveBeenCalledOnce();
  });

  it('does not greet when membership lookup fails', async () => {
    const { context, getChatMember, reply } = createContext();
    const error = new Error('Telegram unavailable');
    getChatMember.mockRejectedValue(error);

    const pending = newChatMembersController(context);
    await vi.advanceTimersByTimeAsync(newChatMembersDelayMs);
    await pending;

    expect(reply).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { err: error, chatId: -1001, event: 'chat_member.greeting_check_failed' },
      'Failed to check new chat member status before greeting',
    );
  });
});
