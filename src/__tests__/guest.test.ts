import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const {
  answerGuestQuery,
  claimGuestInteraction,
  describeTelegramPhoto,
  downloadTelegramFile,
  generateGuestResponse,
  markGuestInteractionAnswered,
  prisma,
  recognize,
  releaseQuota,
  reserveQuota,
  shouldSendLimitNotice,
} = vi.hoisted(() => ({
  answerGuestQuery: vi
    .fn()
    .mockResolvedValue({ inline_message_id: 'inline-1' }),
  claimGuestInteraction: vi.fn().mockResolvedValue({
    kind: 'claimed',
    id: 'interaction-1',
  }),
  describeTelegramPhoto: vi.fn(),
  downloadTelegramFile: vi.fn(),
  generateGuestResponse: vi.fn().mockResolvedValue('## Готово'),
  markGuestInteractionAnswered: vi.fn().mockResolvedValue(undefined),
  prisma: {
    chat: {
      findUnique: vi.fn().mockResolvedValue({ privateModeEnabled: false }),
    },
    message: {
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
  recognize: vi.fn(),
  releaseQuota: vi.fn().mockResolvedValue(undefined),
  reserveQuota: vi.fn().mockResolvedValue({ allowed: true }),
  shouldSendLimitNotice: vi.fn().mockResolvedValue(true),
}));

vi.mock('../ai/guest-generation', () => ({ generateGuestResponse }));
vi.mock('../config', () => ({
  langfuseConfig: { secretKey: 'sk-test', publicKey: 'pk-test' },
  token: 'test-token',
}));
vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../ai/ai', () => ({}));
vi.mock('../db', () => ({ prisma }));
vi.mock('../domain', () => ({
  claimGuestInteraction,
  markGuestInteractionAnswered,
  markGuestInteractionFailed: vi.fn().mockResolvedValue(undefined),
  releaseQuota,
  reserveQuota,
  saveChat: vi.fn().mockResolvedValue(undefined),
  saveMessage: vi.fn().mockResolvedValue({ created: true }),
  saveUser: vi.fn().mockResolvedValue(undefined),
  shouldSendLimitNotice,
}));
vi.mock('../ai/rich-message', () => ({
  createRichMessageIfNeeded: vi.fn().mockReturnValue({ markdown: '## Готово' }),
  toMarkdownV2: vi.fn().mockReturnValue('## Готово'),
}));
vi.mock('../ai/image-description', () => ({
  describeTelegramPhoto,
}));
vi.mock('../application/user-message-analysis', () => ({
  scheduleUserMessageAnalysis: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../telegram-file', () => ({
  downloadTelegramFile,
  TelegramFileTooLargeError: class extends Error {},
}));
vi.mock('../yandex', () => ({
  yandex: { speechkit: { recognize } },
}));
vi.mock('ffmpeg.js', () => ({ default: vi.fn() }));

import { extractGuestQuery, handleGuestMessage } from '../controllers/guest';
import { TelegramFileTooLargeError } from '../telegram-file';

interface MediaOptions {
  photo?: boolean;
  replyPhoto?: boolean;
  voice?: boolean;
  replyVoice?: boolean;
}

function photoSizes() {
  return [{ file_id: 'photo-1', width: 800, height: 600 }];
}

function voiceMedia() {
  return { file_id: 'voice-1', duration: 5, file_size: 1000 };
}

function createContext(
  text: string,
  replyText?: string,
  media: MediaOptions = {},
) {
  const hasReply =
    replyText !== undefined || media.replyPhoto || media.replyVoice;
  const context = {
    me: { id: 999, username: 'phoronis_bot' },
    from: { id: 123 },
    chatId: -100,
    chat: { id: -100, type: 'supergroup', title: 'Test' },
    guestMessage: {
      message_id: 0,
      guest_query_id: 'query-1',
      date: 1,
      chat: { id: -100, type: 'supergroup' },
      from: { id: 123 },
      text,
      ...(media.photo ? { photo: photoSizes() } : {}),
      ...(media.voice ? { voice: voiceMedia() } : {}),
      reply_to_message: hasReply
        ? {
            message_id: 42,
            date: 1,
            chat: { id: -100, type: 'supergroup' },
            from: { id: 456 },
            ...(replyText ? { text: replyText } : {}),
            ...(media.replyPhoto ? { photo: photoSizes() } : {}),
            ...(media.replyVoice ? { voice: voiceMedia() } : {}),
          }
        : undefined,
    },
    answerGuestQuery,
  } as unknown as BotContext;

  return { answerGuestQuery, context };
}

beforeEach(() => {
  vi.clearAllMocks();
  describeTelegramPhoto.mockReset();
  downloadTelegramFile.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  recognize.mockReset().mockResolvedValue('транскрипт войса');
  reserveQuota.mockReset().mockResolvedValue({ allowed: true });
  releaseQuota.mockReset().mockResolvedValue(undefined);
  shouldSendLimitNotice.mockReset().mockResolvedValue(true);
  prisma.message.findUnique.mockReset().mockResolvedValue(null);
});

describe('guestController', () => {
  it('removes the bot mention from a guest query', () => {
    expect(extractGuestQuery('@Phoronis_Bot объясни это', 'phoronis_bot')).toBe(
      'объясни это',
    );
  });

  it('generates one read-only rich response with referenced context', async () => {
    const { answerGuestQuery, context } = createContext(
      '@phoronis_bot почему?',
      'Исходное сообщение',
    );

    await handleGuestMessage(context);

    expect(generateGuestResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'почему?',
        referenceText: 'Исходное сообщение',
        privateMode: false,
      }),
    );
    expect(answerGuestQuery).toHaveBeenCalledWith({
      type: 'article',
      id: 'phoronis-guest-answer',
      title: 'Ответ Ио',
      input_message_content: { rich_message: { markdown: '## Готово' } },
    });
  });

  it('answers with usage guidance when the query has no content', async () => {
    const { answerGuestQuery, context } = createContext('@phoronis_bot');

    await handleGuestMessage(context);

    expect(generateGuestResponse).not.toHaveBeenCalled();
    expect(answerGuestQuery).toHaveBeenCalledOnce();
  });

  it('recognizes a photo attached to the guest query itself', async () => {
    describeTelegramPhoto.mockResolvedValue('описание фото');
    const { context } = createContext('@phoronis_bot опиши', undefined, {
      photo: true,
    });

    await handleGuestMessage(context);

    expect(describeTelegramPhoto).toHaveBeenCalledOnce();
    expect(generateGuestResponse).toHaveBeenCalledWith(
      expect.objectContaining({ imageDescription: 'описание фото' }),
    );
  });

  it('finds a photo in reply_to_message', async () => {
    describeTelegramPhoto.mockResolvedValue('описание фото');
    const { context } = createContext('@phoronis_bot что это?', undefined, {
      replyPhoto: true,
    });

    await handleGuestMessage(context);

    expect(describeTelegramPhoto).toHaveBeenCalledOnce();
    expect(generateGuestResponse).toHaveBeenCalledWith(
      expect.objectContaining({ imageDescription: 'описание фото' }),
    );
  });

  it('uses cached summary without calling vision or spending quota', async () => {
    prisma.message.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ summary: 'кэш-описание' });
    const { context } = createContext('@phoronis_bot что это?', undefined, {
      replyPhoto: true,
    });

    await handleGuestMessage(context);

    expect(describeTelegramPhoto).not.toHaveBeenCalled();
    expect(reserveQuota).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'IMAGE' }),
    );
    expect(generateGuestResponse).toHaveBeenCalledWith(
      expect.objectContaining({ imageDescription: 'кэш-описание' }),
    );
  });

  it('answers the image limit text when IMAGE quota is denied', async () => {
    describeTelegramPhoto.mockResolvedValue('описание фото');
    reserveQuota.mockResolvedValueOnce({ allowed: false });
    const { context } = createContext('@phoronis_bot что это?', undefined, {
      replyPhoto: true,
    });

    await handleGuestMessage(context);

    expect(describeTelegramPhoto).not.toHaveBeenCalled();
    expect(generateGuestResponse).not.toHaveBeenCalled();
    expect(markGuestInteractionAnswered).toHaveBeenCalledWith(
      'interaction-1',
      'Лимит анализа изображений на сегодня закончился.',
    );
  });

  it('falls through to text generation when the limit notice is deduplicated', async () => {
    describeTelegramPhoto.mockResolvedValue('описание фото');
    reserveQuota.mockResolvedValueOnce({ allowed: false });
    shouldSendLimitNotice.mockResolvedValueOnce(false);
    const { context } = createContext('@phoronis_bot что это?', undefined, {
      replyPhoto: true,
    });

    await handleGuestMessage(context);

    expect(describeTelegramPhoto).not.toHaveBeenCalled();
    expect(generateGuestResponse).toHaveBeenCalledWith(
      expect.objectContaining({ imageDescription: undefined }),
    );
    expect(markGuestInteractionAnswered).toHaveBeenCalledWith(
      'interaction-1',
      '## Готово',
    );
  });

  it('transcribes a voice attached to the guest query', async () => {
    const { context } = createContext('@phoronis_bot', undefined, {
      voice: true,
    });

    await handleGuestMessage(context);

    expect(recognize).toHaveBeenCalledOnce();
    expect(generateGuestResponse).toHaveBeenCalledWith(
      expect.objectContaining({ voiceTranscript: 'транскрипт войса' }),
    );
  });

  it('transcribes a voice from reply_to_message', async () => {
    const { context } = createContext(
      '@phoronis_bot что он сказал?',
      undefined,
      {
        replyVoice: true,
      },
    );

    await handleGuestMessage(context);

    expect(recognize).toHaveBeenCalledOnce();
    expect(reserveQuota).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'VOICE' }),
    );
    expect(generateGuestResponse).toHaveBeenCalledWith(
      expect.objectContaining({ voiceTranscript: 'транскрипт войса' }),
    );
  });

  it('answers the voice limit text when VOICE quota is denied', async () => {
    reserveQuota.mockResolvedValueOnce({ allowed: false });
    const { context } = createContext('@phoronis_bot', undefined, {
      voice: true,
    });

    await handleGuestMessage(context);

    expect(recognize).not.toHaveBeenCalled();
    expect(generateGuestResponse).not.toHaveBeenCalled();
    expect(markGuestInteractionAnswered).toHaveBeenCalledWith(
      'interaction-1',
      'Лимит расшифровки голосовых на сегодня закончился.',
    );
  });

  it('returns quota and answers about the size limit for an oversized voice', async () => {
    const reservation = { allowed: true };
    reserveQuota.mockResolvedValueOnce(reservation);
    downloadTelegramFile.mockRejectedValueOnce(new TelegramFileTooLargeError());
    const { context } = createContext('@phoronis_bot', undefined, {
      voice: true,
    });

    await handleGuestMessage(context);

    expect(recognize).not.toHaveBeenCalled();
    expect(releaseQuota).toHaveBeenCalledWith(reservation);
    expect(markGuestInteractionAnswered).toHaveBeenCalledWith(
      'interaction-1',
      'Не могу обработать файл больше 20 МБ.',
    );
  });
});
