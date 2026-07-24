import MD from 'telegramify-markdown';

export const maxRichMessageLength = 32_768;

export const richMarkdownInstructions =
  'Используй Telegram Rich Markdown (GFM): заголовки, списки, таблицы, fenced code, сноски и LaTeX, если это уместно. Не добавляй изображения, видео или аудио по URL.';

export interface SentMessageLike {
  message_id: number;
  date: number;
  from?: { id: number };
}

const mediaMarkdownPattern =
  /!\[[^\]]*\]\((?:https?:\/\/|tg:\/\/(?:photo|video|audio)\?)[^)]*\)/iu;
const mediaHtmlPattern =
  /<(?:img|video|audio|figure|tg-collage|tg-slideshow|tg-map)\b/iu;

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

export function toMarkdownV2(markdown: string): string {
  return MD(markdown, 'remove');
}

export async function sendWithRichFallback(
  markdown: string,
  sendRich: (message: { markdown: string }) => Promise<SentMessageLike>,
  sendMarkdownV2: (text: string) => Promise<SentMessageLike>,
  sendPlain: (text: string) => Promise<SentMessageLike>,
): Promise<SentMessageLike> {
  const richMessage = createRichMessage(markdown);
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
