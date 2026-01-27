import { generateText } from 'ai';
import MD from 'telegramify-markdown';
import { openRouter } from '../ai/ai';
import { bot } from '../bot';
import { prisma } from '../db';
import { logger } from '../logger';
import { saveMessage } from '../shared';

// Список тем Inktober
const inktoberThemes = [
  'Mustache',
  'Weave',
  'Crown',
  'Murky',
  'Deer',
  'Pierce',
  'Starfish',
  'Reckless',
  'Heavy',
  'Sweep',
  'Sting',
  'Shredded',
  'Drink',
  'Trunk',
  'Ragged',
  'Blunder',
  'Ornate',
  'Deal',
  'Arctic',
  'Rivals',
  'Blast',
  'Button',
  'Firefly',
  'Rowdy',
  'Inferno',
  'Puzzling',
  'Onion',
  'Skeletal',
  'Lesson',
  'Vacant',
  'Award',
];

// Функция для получения темы дня
function getThemeOfDay(): string {
  const today = new Date();
  const dayOfMonth = today.getDate();
  const themeIndex = (dayOfMonth - 1) % inktoberThemes.length;
  return inktoberThemes[themeIndex];
}

// Функция для генерации сообщения
async function generateInktoberMessage(): Promise<string> {
  try {
    const today = new Date();
    const day = today.getDate();
    const theme = getThemeOfDay();

    const message = await generateText({
      model: openRouter('google/gemini-2.5-flash-lite'),
      prompt: `Сегодня ${day} октября - день ${day} из Inktober! 🎨

Тема дня: ${theme}

Напиши вдохновляющее сообщение для чата, включающее:
1. Короткое приветствие и мотивацию для участия в Inktober
2. Тему дня на английском и русском языках
3. 2-3 креативные идеи для рисунка на эту тему
4. Хэштеги #inktober и #inktober${day}
5. Подходящий эмодзи

Сделай сообщение живым и вдохновляющим!`,
      temperature: 1,
    }).then((r) => r.text);

    return message;
  } catch (error) {
    logger.error(error, 'Ошибка при генерации сообщения для Inktober');
    // Возвращаем стандартное сообщение в случае ошибки
    const today = new Date();
    const day = today.getDate();
    const theme = getThemeOfDay();
    return `Всем привет! Сегодня ${day} октября - день ${day} из Inktober! 🎨\n\nТема дня: ${theme}\n\nВремя для ежедневного рисования! Покажите свои творения!\n\n#inktober #inktober${day}`;
  }
}

// Функция для отправки сообщения в конкретный чат
export async function sendInktoberMessage(
  chatId: number | bigint,
): Promise<void> {
  const message = await generateInktoberMessage();
  try {
    // Убедимся, что chatId - это number или string для API Telegram
    const targetChatId = typeof chatId === 'bigint' ? Number(chatId) : chatId;
    const reply = await bot.api.sendMessage(
      targetChatId,
      MD(message, 'remove'),
      {
        parse_mode: 'MarkdownV2',
      },
    );
    logger.info(`Сообщение Inktober отправлено в чат ${targetChatId}`);

    await saveMessage({
      id: reply.message_id,
      chatId,
      senderId: reply.from!.id,
      sentAt: new Date(reply.date * 1000),
      messageType: 'TEXT',
      text: message,
    });
  } catch (error) {
    logger.error(
      error,
      `Ошибка при отправке сообщения Inktober в чат ${chatId}`,
    );
    // Здесь можно добавить логику обработки ошибок, например, отключить фичу для этого чата, если бот заблокирован
  }
}
