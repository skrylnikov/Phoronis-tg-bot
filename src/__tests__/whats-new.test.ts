import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    chat: { findMany: vi.fn() },
    message: { count: vi.fn() },
  },
}));

vi.mock('../config', () => ({ analyticsChatId: 777 }));
vi.mock('../bot', () => ({}));
vi.mock('../db', () => ({ prisma }));
vi.mock('../logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../shared', () => ({
  weeklyPromotionEndsAt: new Date('2026-08-02T21:00:00.000Z'),
}));

import {
  broadcastDelayMs,
  buildWhatsNewPost,
  whatsNewCallbackController,
  whatsNewController,
} from '../controllers/whats-new';

function createContext(input?: {
  chatType?: 'private' | 'group';
  userId?: number;
  callbackData?: string;
}) {
  const reply = vi.fn().mockResolvedValue({ message_id: 1, date: 1 });
  const replyWithRichMessage = vi
    .fn()
    .mockResolvedValue({ message_id: 1, date: 1 });
  const answerCallbackQuery = vi.fn().mockResolvedValue(true);
  const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);
  const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 2, date: 1 });
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 3, date: 1 });

  return {
    answerCallbackQuery,
    context: {
      chat: { id: 777, type: input?.chatType ?? 'private' },
      chatId: 777,
      from: { id: input?.userId ?? 777 },
      me: { id: 999 },
      callbackQuery: input?.callbackData
        ? { data: input.callbackData }
        : undefined,
      reply,
      replyWithRichMessage,
      answerCallbackQuery,
      editMessageReplyMarkup,
      api: { sendRichMessage, sendMessage },
    } as unknown as BotContext,
    editMessageReplyMarkup,
    reply,
    replyWithRichMessage,
    sendMessage,
    sendRichMessage,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.chat.findMany.mockResolvedValue([
    { id: -1001n, title: 'Первый чат' },
    { id: -1002n, title: 'Второй чат' },
  ]);
  prisma.message.count.mockResolvedValueOnce(123).mockResolvedValueOnce(45);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('whats-new broadcast', () => {
  it('builds the rich post with promotion, limits, and current statistics', () => {
    const markdown = buildWhatsNewPost(
      { botReplies: 123, recognizedVoices: 45 },
      new Date('2026-07-28T12:00:00.000Z'),
    );

    expect(markdown).toContain('## Ио: большое обновление');
    expect(markdown).toContain('<details>');
    expect(markdown).toContain('29 / 49 / 99 / 299 ⭐');
    expect(markdown).toContain('123 сообщений');
    expect(markdown).toContain('45 голосовых сообщений и кружков');
    expect(markdown).toContain('3 бесплатных + 10 по тарифу = 13 ответов');
    expect(markdown).toContain('участники не тратят лимиты друг друга');
    expect(markdown).not.toContain('При обновлении лимитов');
  });

  it('only shows the preview to the owner in a private chat', async () => {
    const { context, replyWithRichMessage } = createContext();

    await whatsNewController(context);

    expect(prisma.chat.findMany).toHaveBeenCalledWith({
      where: { chatType: 'GROUP' },
      select: { id: true, title: true },
    });
    expect(replyWithRichMessage).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: expect.stringContaining('Ио') }),
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: [
            [
              expect.objectContaining({
                callback_data: expect.stringMatching(/^whatsnew:/),
                text: 'Разослать',
              }),
            ],
          ],
        }),
      }),
    );

    const nonOwner = createContext({ userId: 778 });
    await whatsNewController(nonOwner.context);
    expect(nonOwner.replyWithRichMessage).not.toHaveBeenCalled();

    const groupOwner = createContext({ chatType: 'group' });
    await whatsNewController(groupOwner.context);
    expect(groupOwner.replyWithRichMessage).not.toHaveBeenCalled();
  });

  it('sends sequentially, continues after a kicked chat, and reports totals', async () => {
    const preview = createContext();
    await whatsNewController(preview.context);
    const callbackData =
      preview.replyWithRichMessage.mock.calls[0]?.[1].reply_markup
        .inline_keyboard[0][0].callback_data;
    const broadcast = createContext({ callbackData });
    const kickedError = new Error('Forbidden: bot was kicked from the group');
    broadcast.sendRichMessage
      .mockResolvedValueOnce({ message_id: 2, date: 1 })
      .mockRejectedValue(kickedError);
    broadcast.sendMessage.mockImplementation((chatId: number) =>
      chatId === 777
        ? Promise.resolve({ message_id: 3, date: 1 })
        : Promise.reject(kickedError),
    );

    await whatsNewCallbackController(broadcast.context);
    expect(broadcast.sendRichMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(broadcastDelayMs);

    expect(broadcast.sendRichMessage).toHaveBeenCalledTimes(2);
    expect(broadcast.sendMessage).toHaveBeenCalledWith(
      777,
      [
        'Рассылка завершена.',
        'Всего групп: 2',
        'Успешно отправлено: 1',
        'Не доставлено: 1',
      ].join('\n'),
    );
    expect(broadcast.editMessageReplyMarkup).toHaveBeenCalledOnce();

    await whatsNewCallbackController(broadcast.context);
    expect(broadcast.answerCallbackQuery).toHaveBeenLastCalledWith({
      text: 'Подтверждение устарело',
    });
  });

  it('releases the broadcaster lock when callback acknowledgement fails', async () => {
    prisma.chat.findMany.mockResolvedValueOnce([]);
    const preview = createContext();
    await whatsNewController(preview.context);
    const callbackData =
      preview.replyWithRichMessage.mock.calls[0]?.[1].reply_markup
        .inline_keyboard[0][0].callback_data;
    const failed = createContext({ callbackData });
    failed.answerCallbackQuery.mockRejectedValueOnce(new Error('Network'));

    await expect(whatsNewCallbackController(failed.context)).rejects.toThrow(
      'Network',
    );

    const retry = createContext({ callbackData });
    await whatsNewCallbackController(retry.context);
    await vi.runAllTimersAsync();

    expect(retry.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Рассылка началась',
    });
    expect(retry.sendMessage).toHaveBeenCalledWith(
      777,
      [
        'Рассылка завершена.',
        'Всего групп: 0',
        'Успешно отправлено: 0',
        'Не доставлено: 0',
      ].join('\n'),
    );
  });
});
