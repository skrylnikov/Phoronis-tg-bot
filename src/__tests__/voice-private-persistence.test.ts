import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  editMessageText: vi.fn(),
  findChatByIdRepo: vi.fn(),
  findFirstMessageRepo: vi.fn(),
  generateText: vi.fn(),
  getFile: vi.fn(),
  recognize: vi.fn(),
  reserveQuota: vi.fn(),
  saveMessage: vi.fn(),
  updateMessageFieldsRepo: vi.fn(),
}));

vi.mock('../ai', () => ({
  utilityModel: {},
}));
vi.mock('../ai/rich-message', () => ({
  createRichMessageIfNeeded: vi.fn(() => null),
  richMarkdownInstructions: '',
  toMarkdownV2: vi.fn((text: string) => text),
}));
vi.mock('ai', () => ({ generateText: mocks.generateText }));
vi.mock('ffmpeg.js', () => ({ default: vi.fn() }));
vi.mock('../config.js', () => ({ token: 'token' }));
vi.mock('../domain', () => ({
  releaseQuota: vi.fn(),
  reserveQuota: mocks.reserveQuota,
  saveChat: vi.fn(),
  saveMessage: mocks.saveMessage,
  saveUser: vi.fn(),
}));
vi.mock('../logger', () => ({ logger: { debug: vi.fn(), error: vi.fn() } }));
vi.mock('../repositories', () => ({
  findChatByIdRepo: mocks.findChatByIdRepo,
  findFirstMessageRepo: mocks.findFirstMessageRepo,
  updateMessageFieldsRepo: mocks.updateMessageFieldsRepo,
}));
vi.mock('../update-signal.js', () => ({
  currentUpdateAbortSignal: vi.fn(),
}));
vi.mock('../yandex', () => ({
  yandex: { speechkit: { recognize: mocks.recognize } },
}));
vi.mock('../controllers/limit-notice', () => ({
  sendMediaLimitNotice: vi.fn(),
}));

import { voiceController } from '../controllers/voice';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findChatByIdRepo.mockResolvedValue({ privateModeEnabled: true });
  mocks.findFirstMessageRepo.mockResolvedValue(null);
  mocks.getFile.mockResolvedValue({ file_path: 'voice.ogg' });
  mocks.generateText.mockResolvedValue({ text: 'Красивый текст' });
  mocks.recognize.mockResolvedValue('Распознанный текст');
  mocks.reserveQuota.mockResolvedValue({ allowed: true });
  mocks.saveMessage.mockResolvedValue({ created: true });
  mocks.updateMessageFieldsRepo.mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('private voice persistence', () => {
  it('marks both the voice message and bot response as private', async () => {
    const message = {
      chat: { id: 100, type: 'private' },
      date: 1_750_000_000,
      from: { id: 42, is_bot: false, first_name: 'User' },
      message_id: 41,
      voice: { duration: 1, file_id: 'voice-41', file_size: 1 },
    };
    const ctx = {
      api: { editMessageText: mocks.editMessageText, getFile: mocks.getFile },
      chat: message.chat,
      chatId: 100,
      from: message.from,
      me: { id: 999, is_bot: true, first_name: 'Bot' },
      message,
      msg: message,
      reply: vi.fn().mockResolvedValue({
        date: 1_750_000_001,
        from: { id: 999, is_bot: true, first_name: 'Bot' },
        message_id: 42,
        text: 'Распознанный текст',
      }),
      replyWithChatAction: vi.fn(),
    } as never;

    await voiceController(ctx);

    expect(mocks.saveMessage).toHaveBeenCalledTimes(2);
    expect(mocks.saveMessage.mock.calls).toEqual(
      expect.arrayContaining([
        [expect.objectContaining({ messageType: 'VOICE', private: true })],
        [expect.objectContaining({ messageType: 'VOICE', private: true })],
      ]),
    );
  });
});
