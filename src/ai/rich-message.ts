import MD from 'telegramify-markdown';

export const maxRichMessageLength = 32_768;

export const richMarkdownInstructions =
  'Для обычного текста, выделений, ссылок, цитат, кода и простых списков используй простой Telegram Markdown. Используй GFM-конструкции Rich Markdown (заголовки, таблицы, task lists, сноски, LaTeX и HTML-блоки) только когда они действительно улучшают ответ. Не добавляй изображения, видео или аудио по URL.';

export interface SentMessageLike {
  message_id: number;
  date: number;
  from?: { id: number };
}

const mediaMarkdownPattern =
  /!\[[^\]]*\]\((?:https?:\/\/|tg:\/\/(?:photo|video|audio)\?)[^)]*\)/iu;
const mediaHtmlPattern =
  /<(?:img|video|audio|figure|tg-collage|tg-slideshow|tg-map)\b/iu;
const richMarkdownPatterns = [
  /(?:^|\n) {0,3}#{1,6}\s+/u,
  /(?:^|\n)\s*\|.+\|\s*\n\s*\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*(?:\n|$)/u,
  /\[\^[^\]\n]+\](?:\[[^\]]*\])?|(?:^|\n)\[\^[^\]\n]+\]:/u,
  /(?<!\\)\$\$(?:.|\n)+?(?<!\\)\$\$|(?<!\\)\$(?!\s)(?:[^$\n\\]|\\.)+?(?<!\\)\$/u,
  /(?:^|\n)\s*[-*+]\s+\[[ xX]\]\s+/u,
  /<(?:details|summary|tg-[\w-]+)\b/iu,
];

export function hasRichMedia(markdown: string): boolean {
  return mediaMarkdownPattern.test(markdown) || mediaHtmlPattern.test(markdown);
}

export function createRichMessage(
  markdown: string,
): { markdown: string } | undefined {
  if (markdown.length > maxRichMessageLength || hasRichMedia(markdown)) {
    return undefined;
  }

  return { markdown };
}

export function requiresRichMarkdown(markdown: string): boolean {
  return richMarkdownPatterns.some((pattern) => pattern.test(markdown));
}

export function createRichMessageIfNeeded(
  markdown: string,
): { markdown: string } | undefined {
  return requiresRichMarkdown(markdown)
    ? createRichMessage(markdown)
    : undefined;
}

export function toMarkdownV2(markdown: string): string {
  return MD(markdown, 'remove');
}

export async function sendWithRichFallback(
  markdown: string,
  sendRich: (message: { markdown: string }) => Promise<SentMessageLike>,
  sendMarkdownV2: (text: string) => Promise<SentMessageLike>,
  sendPlain: (text: string) => Promise<SentMessageLike>,
): Promise<SentMessageLike> {
  const richMessage = createRichMessageIfNeeded(markdown);
  if (richMessage) {
    try {
      return await sendRich(richMessage);
    } catch {
      // Try the legacy formatting below when Rich Messages are unavailable.
    }
  }

  try {
    return await sendMarkdownV2(toMarkdownV2(markdown));
  } catch {
    return sendPlain(markdown);
  }
}
