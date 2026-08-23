import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  aiController: vi.fn(),
  describeTelegramPhoto: vi.fn(),
  findChatByIdRepo: vi.fn(),
  findMessageWithSelectRepo: vi.fn(),
  getFile: vi.fn(),
  reserveQuota: vi.fn(),
  saveMessage: vi.fn(),
  updateMessageSummaryRepo: vi.fn(),
}));

vi.mock('../ai', () => ({
  aiController: mocks.aiController,
  queueMessageEmbedding: vi.fn(),
  searchAndIndexMessage: vi.fn(),
}));
vi.mock('../ai/image-description', () => ({
  describeTelegramPhoto: mocks.describeTelegramPhoto,
}));
vi.mock('../application/user-message-analysis', () => ({
  scheduleUserMessageAnalysis: vi.fn(),
}));
vi.mock('../domain', () => ({
  releaseQuota: vi.fn(),
  reserveQuota: mocks.reserveQuota,
  saveChat: vi.fn(),
  saveMessage: mocks.saveMessage,
  saveUser: vi.fn(),
}));
vi.mock('../domain/user/fact-impact-tracker', () => ({
  recordUserReaction: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getFile.mockResolvedValue({ file_path: 'photos/image.jpg' });
  mocks.findChatByIdRepo.mockResolvedValue({ privateModeEnabled: true });
  mocks.saveMessage.mockResolvedValue({ created: true });
  mocks.reserveQuota.mockResolvedValue({ allowed: true });
  mocks.describeTelegramPhoto.mockResolvedValue('Описание фото');
});

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
      } as never;

      await processMessageController.middleware()(ctx, async () => {});

      expect(mocks.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ private: true }),
      );
      expect(mocks.aiController.mock.calls[0]?.[4]).toMatchObject({
        privateMode: true,
      });
    },
  );
});
