import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { openRouterToken } from "../config"; // Импортируем токен
import { bot } from "../bot"; // Импортируем экземпляр бота
import { logger } from "../logger"; // Импортируем логгер

// Используем ту же модель, что и в chat-generation
const geminiFlash2 = new ChatOpenAI({
  model: "google/gemini-2.5-flash-lite",
  apiKey: openRouterToken,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
  temperature: 1, // Можно сделать температуру повыше для креативности
});

// Список тем Inktober
const inktoberThemes = [
  "Mustache", "Weave", "Crown", "Murky", "Deer", "Pierce", "Starfish", "Reckless", "Heavy", "Sweep",
  "Sting", "Shredded", "Drink", "Trunk", "Ragged", "Blunder", "Ornate", "Deal", "Arctic", "Rivals",
  "Blast", "Button", "Firefly", "Rowdy", "Inferno", "Puzzling", "Onion", "Skeletal", "Lesson", "Vacant", "Award"
];

// Функция для получения темы дня
function getThemeOfDay(): string {
  const today = new Date();
  const dayOfMonth = today.getDate();
  const themeIndex = (dayOfMonth - 1) % inktoberThemes.length;
  return inktoberThemes[themeIndex];
}

// Промпт для генерации сообщения
const promptTemplate = PromptTemplate.fromTemplate(
  `Сегодня {day} октября - день {dayOfInktober} из Inktober! 🎨

Тема дня: {theme}

Напиши вдохновляющее сообщение для чата, включающее:
1. Короткое приветствие и мотивацию для участия в Inktober
2. Тему дня на английском и русском языках
3. 2-3 креативные идеи для рисунка на эту тему
4. Хэштеги #inktober и #inktober{day}
5. Подходящий эмодзи

 Сделай сообщение живым и вдохновляющим!`
);

const outputParser = new StringOutputParser();

const chain = promptTemplate.pipe(geminiFlash2).pipe(outputParser);

// Функция для генерации сообщения
async function generateInktoberMessage(): Promise<string> {
  try {
    const today = new Date();
    const day = today.getDate();
    const theme = getThemeOfDay();
    
    const message = await chain.invoke({
      day: day.toString(),
      dayOfInktober: day.toString(),
      theme: theme,
    });
    
    // Дополнительная проверка или форматирование, если нужно
    if (!message.includes("#inktober")) {
        return message + "\n#inktober"; // Гарантируем наличие хештега
    }
    return message;
  } catch (error) {
    logger.error("Ошибка при генерации сообщения для Inktober:", error);
    // Возвращаем стандартное сообщение в случае ошибки
    const today = new Date();
    const day = today.getDate();
    const theme = getThemeOfDay();
    return `Всем привет! Сегодня ${day} октября - день ${day} из Inktober! 🎨\n\nТема дня: ${theme}\n\nВремя для ежедневного рисования! Покажите свои творения!\n\n#inktober #inktober${day}`;
  }
}

// Функция для отправки сообщения в конкретный чат
export async function sendInktoberMessage(chatId: number | bigint): Promise<void> {
  const message = await generateInktoberMessage();
  try {
    // Убедимся, что chatId - это number или string для API Telegram
    const targetChatId = typeof chatId === 'bigint' ? Number(chatId) : chatId;
    await bot.api.sendMessage(targetChatId, message);
    logger.info(`Сообщение Inktober отправлено в чат ${targetChatId}`);
  } catch (error) {
    logger.error(`Ошибка при отправке сообщения Inktober в чат ${chatId}:`, error);
    // Здесь можно добавить логику обработки ошибок, например, отключить фичу для этого чата, если бот заблокирован
  }
}
