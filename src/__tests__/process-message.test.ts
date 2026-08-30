import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  aiController: vi.fn(),
  describeTelegramPhoto: vi.fn(),
  findChatByIdRepo: vi.fn(),
  findMessageWithSelectRepo: vi.fn(),
  getFile: vi.fn(),
  releaseQuota: vi.fn(),
  reserveQuota: vi.fn(),
  saveMessage: vi.fn(),
  searchAndIndexMessage: vi.fn(),
  searchContext: vi.fn(),
  updateMessageSummaryRepo: vi.fn(),
}));

vi.mock('../ai', () => ({
  aiController: mocks.aiController,
  queueMessageEmbedding: vi.fn(),
  searchAndIndexMessage: mocks.searchAndIndexMessage,
  searchContext: mocks.searchContext,
}));
vi.mock('../ai/image-description', () => ({
  describeTelegramPhoto: mocks.describeTelegramPhoto,
}));
vi.mock('../application/user-message-analysis', () => ({
  scheduleUserMessageAnalysis: vi.fn(),
}));
vi.mock('../config', () => ({
  sessionIdGenerator: vi.fn(() => 'session'),
}));
vi.mock('../domain', () => ({
  releaseQuota: mocks.releaseQuota,
  reserveQuota: mocks.reserveQuota,
  saveChat: vi.fn(),
  saveMessage: mocks.saveMessage,
  saveUser: vi.fn(),
}));
vi.mock('../logger', () => ({ logger: { debug: vi.fn(), error: vi.fn() } }));
vi.mock('../repositories', () => ({
  findChatByIdRepo: mocks.findChatByIdRepo,
  findMessageWithSelectRepo: mocks.findMessageWithSelectRepo,
  updateMessageSummaryRepo: mocks.updateMessageSummaryRepo,
}));
vi.mock('../utils/error-handler', () => ({ handleError: vi.fn() }));
vi.mock('../controllers/limit-notice', () => ({
  sendMediaLimitNotice: vi.fn(),
}));

import {
  findPhotoInReplyChain,
  processMessageController,
} from '../controllers/process-message';

function createContext() {
  return {
    chatId: -100,
    api: { getFile: mocks.getFile },
  } as never;
}

function mockDbMessages(
  messages: Record<
    string,
    { media: string | null; replyToMessageId: bigint | null }
  >,
) {
  mocks.findMessageWithSelectRepo.mockImplementation(
    async (_chatId: bigint, messageId: bigint) =>
      messages[messageId.toString()] ?? null,
  );
}

function imageMedia(fileId: string): string {
  return JSON.stringify({ fileId, mimeType: 'image/jpeg' });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getFile.mockResolvedValue({ file_path: 'photos/image.jpg' });
  mocks.findChatByIdRepo.mockResolvedValue({ privateModeEnabled: true });
  mocks.saveMessage.mockResolvedValue({ created: true });
  mocks.reserveQuota.mockResolvedValue({ allowed: true });
  mocks.describeTelegramPhoto.mockResolvedValue('Описание фото');
  mocks.searchContext.mockResolvedValue({
    userContext: ['контекст'],
    chatContext: null,
  });
});

afterEach(() => vi.useRealTimers());

describe('findPhotoInReplyChain DB fallback', () => {
  it('finds a photo after two DB parent hops', async () => {
    mockDbMessages({
      '300': { media: null, replyToMessageId: 200n },
      '200': { media: null, replyToMessageId: 100n },
      '100': { media: imageMedia('photo-100'), replyToMessageId: null },
    });

    const result = await findPhotoInReplyChain(
      createContext(),
      { message_id: 300 },
      3,
    );

    expect(result).toMatchObject({
      messageId: 100,
      photo: { file_id: 'photo-100' },
    });
    expect(mocks.findMessageWithSelectRepo).toHaveBeenCalledTimes(3);
  });

  it('finds a photo after three DB parent hops', async () => {
    mockDbMessages({
      '400': { media: null, replyToMessageId: 300n },
      '300': { media: null, replyToMessageId: 200n },
      '200': { media: null, replyToMessageId: 100n },
      '100': { media: imageMedia('photo-100'), replyToMessageId: null },
    });

    const result = await findPhotoInReplyChain(
      createContext(),
      { message_id: 400 },
      4,
    );

    expect(result?.messageId).toBe(100);
    expect(mocks.findMessageWithSelectRepo).toHaveBeenCalledTimes(4);
  });

  it('checks a root DB record for media before stopping without a parent', async () => {
    mockDbMessages({
      '100': { media: imageMedia('root-photo'), replyToMessageId: null },
    });

    const result = await findPhotoInReplyChain(createContext(), {
      message_id: 100,
    });

    expect(result).toMatchObject({
      messageId: 100,
      photo: { file_id: 'root-photo' },
    });
  });

  it('does not cross the configured maximum depth', async () => {
    mockDbMessages({
      '400': { media: null, replyToMessageId: 300n },
      '300': { media: null, replyToMessageId: 200n },
      '200': { media: imageMedia('too-deep'), replyToMessageId: null },
    });

    const result = await findPhotoInReplyChain(
      createContext(),
      { message_id: 400 },
      2,
    );

    expect(result).toBeNull();
    expect(mocks.findMessageWithSelectRepo).toHaveBeenCalledTimes(2);
    expect(mocks.getFile).not.toHaveBeenCalled();
  });
});

describe('private message persistence', () => {
  it.each(['text', 'photo'])(
    'marks %s input and AI response as private',
    async (messageType) => {
      const message =
        messageType === 'text'
          ? {
              message_id: 41,
              date: 1_750_000_000,
              text: 'Привет',
            }
          : {
              message_id: 41,
              date: 1_750_000_000,
              caption: 'Фото',
              photo: [
                { file_id: 'photo-41', width: 100, height: 100, file_size: 1 },
              ],
            };
      const ctx = {
        api: { getFile: mocks.getFile },
        chat: { id: 100, type: 'private', first_name: 'User' },
        chatId: 100,
        from: { id: 42, is_bot: false, first_name: 'User' },
        me: { id: 999, is_bot: true, first_name: 'Bot' },
        msg: message,
        update: { message },
        replyWithChatAction: vi.fn().mockResolvedValue(true),
      } as never;

      await processMessageController.middleware()(ctx, async () => {});

      expect(mocks.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ private: true }),
      );
      expect(mocks.aiController.mock.calls[0]?.[4]).toMatchObject({
        includeRecentChatContext: true,
        privateMode: true,
      });
      if (messageType === 'text') {
        expect(mocks.searchContext).toHaveBeenCalled();
        expect(mocks.searchAndIndexMessage).not.toHaveBeenCalled();
      } else {
        expect(mocks.aiController.mock.calls[0]?.[4]).toMatchObject({
          resolveContext: true,
        });
      }
    },
  );
});

describe('early typing status', () => {
  it('starts typing before text context search', async () => {
    const events: string[] = [];
    mocks.findChatByIdRepo.mockResolvedValue({ privateModeEnabled: false });
    mocks.searchAndIndexMessage.mockImplementation(async () => {
      events.push('search');
      return { userContext: null, chatContext: null };
    });
    const ctx = {
      api: { getFile: mocks.getFile },
      chat: { id: -100, type: 'supergroup' },
      chatId: -100,
      from: { id: 42, is_bot: false, first_name: 'User' },
      me: { id: 999, is_bot: true, first_name: 'Bot' },
      msg: { message_id: 41, date: 1_750_000_000, text: 'Ио, привет' },
      update: { message: { message_id: 41, text: 'Ио, привет' } },
      replyWithChatAction: vi.fn().mockImplementation(async () => {
        events.push('typing');
      }),
    } as never;

    await processMessageController.middleware()(ctx, async () => {});

    expect(events).toEqual(['typing', 'search']);
  });

  it('starts typing before photo recognition', async () => {
    const events: string[] = [];
    mocks.findChatByIdRepo.mockResolvedValue({ privateModeEnabled: false });
    mocks.describeTelegramPhoto.mockImplementation(async () => {
      events.push('describe');
      return 'Описание фото';
    });
    const ctx = {
      api: { getFile: mocks.getFile },
      chat: { id: -100, type: 'supergroup' },
      chatId: -100,
      from: { id: 42, is_bot: false, first_name: 'User' },
      me: { id: 999, is_bot: true, first_name: 'Bot' },
      msg: {
        message_id: 41,
        date: 1_750_000_000,
        caption: 'Ио, опиши фото',
        photo: [{ file_id: 'photo-41', width: 100, height: 100, file_size: 1 }],
      },
      update: {
        message: {
          message_id: 41,
          caption: 'Ио, опиши фото',
          photo: [{ file_id: 'photo-41', width: 100, height: 100 }],
        },
      },
      replyWithChatAction: vi.fn().mockImplementation(async () => {
        events.push('typing');
      }),
    } as never;

    await processMessageController.middleware()(ctx, async () => {});

    expect(events).toEqual(['typing', 'describe']);
  });

  it('refreshes typing while a replied photo is recognized', async () => {
    vi.useFakeTimers();
    mocks.findChatByIdRepo.mockResolvedValue({ privateModeEnabled: false });
    mocks.searchAndIndexMessage.mockResolvedValue({
      userContext: null,
      chatContext: null,
    });
    const recognition = deferred<string>();
    mocks.describeTelegramPhoto.mockReturnValue(recognition.promise);
    const replyWithChatAction = vi.fn().mockResolvedValue(true);
    const message = {
      message_id: 41,
      date: 1_750_000_000,
      text: 'Ио, опиши фото',
      reply_to_message: {
        message_id: 40,
        photo: [{ file_id: 'photo-40', width: 100, height: 100 }],
      },
    };
    const ctx = {
      api: { getFile: mocks.getFile },
      chat: { id: -100, type: 'supergroup' },
      chatId: -100,
      from: { id: 42, is_bot: false, first_name: 'User' },
      me: { id: 999, is_bot: true, first_name: 'Bot' },
      msg: message,
      update: { message },
      replyWithChatAction,
    } as never;

    const processing = processMessageController.middleware()(
      ctx,
      async () => {},
    );
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.describeTelegramPhoto).toHaveBeenCalled();
    expect(replyWithChatAction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(replyWithChatAction).toHaveBeenCalledTimes(3);

    recognition.resolve('Описание фото');
    await processing;
    const callsAfterCompletion = replyWithChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8_000);

    expect(replyWithChatAction).toHaveBeenCalledTimes(callsAfterCompletion);
  });

  it('refreshes typing while a direct photo is recognized', async () => {
    vi.useFakeTimers();
    mocks.findChatByIdRepo.mockResolvedValue({ privateModeEnabled: false });
    const recognition = deferred<string>();
    mocks.describeTelegramPhoto.mockReturnValue(recognition.promise);
    const replyWithChatAction = vi.fn().mockResolvedValue(true);
    const message = {
      message_id: 41,
      date: 1_750_000_000,
      caption: 'Ио, опиши фото',
      photo: [{ file_id: 'photo-41', width: 100, height: 100, file_size: 1 }],
    };
    const ctx = {
      api: { getFile: mocks.getFile },
      chat: { id: -100, type: 'supergroup' },
      chatId: -100,
      from: { id: 42, is_bot: false, first_name: 'User' },
      me: { id: 999, is_bot: true, first_name: 'Bot' },
      msg: message,
      update: { message },
      replyWithChatAction,
    } as never;

    const processing = processMessageController.middleware()(
      ctx,
      async () => {},
    );
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.describeTelegramPhoto).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(replyWithChatAction).toHaveBeenCalledTimes(2);

    recognition.resolve('Описание фото');
    await processing;

    expect(mocks.aiController.mock.calls[0]?.[4]).toMatchObject({
      typingStatus: { stop: expect.any(Function) },
    });
  });

  it('stops refreshing typing when photo recognition fails', async () => {
    vi.useFakeTimers();
    mocks.findChatByIdRepo.mockResolvedValue({ privateModeEnabled: false });
    const reservation = { allowed: true };
    mocks.reserveQuota.mockResolvedValue(reservation);
    const recognitionError = new Error('Vision unavailable');
    mocks.describeTelegramPhoto.mockRejectedValue(recognitionError);
    const replyWithChatAction = vi.fn().mockResolvedValue(true);
    const message = {
      message_id: 41,
      date: 1_750_000_000,
      caption: 'Ио, опиши фото',
      photo: [{ file_id: 'photo-41', width: 100, height: 100, file_size: 1 }],
    };
    const ctx = {
      api: { getFile: mocks.getFile },
      chat: { id: -100, type: 'supergroup' },
      chatId: -100,
      from: { id: 42, is_bot: false, first_name: 'User' },
      me: { id: 999, is_bot: true, first_name: 'Bot' },
      msg: message,
      update: { message },
      replyWithChatAction,
    } as never;

    await expect(
      processMessageController.middleware()(ctx, async () => {}),
    ).rejects.toThrow(recognitionError);

    expect(mocks.releaseQuota).toHaveBeenCalledWith(reservation);
    const callsAfterFailure = replyWithChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(replyWithChatAction).toHaveBeenCalledTimes(callsAfterFailure);
  });

  it('stops refreshing typing when the image quota is denied', async () => {
    vi.useFakeTimers();
    mocks.findChatByIdRepo.mockResolvedValue({ privateModeEnabled: false });
    mocks.reserveQuota.mockResolvedValue({ allowed: false });
    const replyWithChatAction = vi.fn().mockResolvedValue(true);
    const message = {
      message_id: 41,
      date: 1_750_000_000,
      caption: 'Ио, опиши фото',
      photo: [{ file_id: 'photo-41', width: 100, height: 100, file_size: 1 }],
    };
    const ctx = {
      api: { getFile: mocks.getFile },
      chat: { id: -100, type: 'supergroup' },
      chatId: -100,
      from: { id: 42, is_bot: false, first_name: 'User' },
      me: { id: 999, is_bot: true, first_name: 'Bot' },
      msg: message,
      update: { message },
      replyWithChatAction,
    } as never;

    await processMessageController.middleware()(ctx, async () => {});

    const callsAfterQuotaDenial = replyWithChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(replyWithChatAction).toHaveBeenCalledTimes(callsAfterQuotaDenial);
    expect(mocks.describeTelegramPhoto).not.toHaveBeenCalled();
    expect(mocks.aiController).not.toHaveBeenCalled();
  });

  it('does not start typing for a skipped group message', async () => {
    mocks.findChatByIdRepo.mockResolvedValue({ privateModeEnabled: false });
    const replyWithChatAction = vi.fn().mockResolvedValue(true);
    const ctx = {
      api: { getFile: mocks.getFile },
      chat: { id: -100, type: 'supergroup' },
      chatId: -100,
      from: { id: 42, is_bot: false, first_name: 'User' },
      me: { id: 999, is_bot: true, first_name: 'Bot' },
      msg: {
        message_id: 41,
        date: 1_750_000_000,
        caption: 'Фото без обращения',
        photo: [{ file_id: 'photo-41', width: 100, height: 100, file_size: 1 }],
      },
      update: {
        message: {
          message_id: 41,
          caption: 'Фото без обращения',
          photo: [{ file_id: 'photo-41', width: 100, height: 100 }],
        },
      },
      replyWithChatAction,
    } as never;

    await processMessageController.middleware()(ctx, async () => {});

    expect(replyWithChatAction).not.toHaveBeenCalled();
    expect(mocks.aiController).not.toHaveBeenCalled();
  });
});
