import type { PhotoSize } from '@grammyjs/types';
import { generateText } from 'ai';
import type { BotContext } from '../bot';
import { token } from '../config';
import { currentUpdateAbortSignal } from '../update-signal';
import { utilityModel } from './ai';
import { langfuse } from './langfuse';

export async function describeTelegramPhoto(
  ctx: BotContext,
  photo: PhotoSize,
): Promise<string> {
  const fileLink = await ctx.api.getFile(photo.file_id);
  if (!fileLink.file_path)
    throw new Error('Telegram did not return photo path');
  const prompt = await langfuse.getPrompt('image-description');
  const response = await generateText({
    abortSignal: currentUpdateAbortSignal(),
    model: utilityModel,
    instructions: prompt.compile(),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            mediaType: 'image/jpeg',
            data: {
              type: 'url',
              url: new URL(
                `https://api.telegram.org/file/bot${token}/${fileLink.file_path}`,
              ),
            },
          },
        ],
      },
    ],
    temperature: 0,
  });
  return response.text;
}
