import type { PhotoSize } from '@grammyjs/types';
import { generateText } from 'ai';
import type { BotContext } from '../bot';
import { downloadTelegramFile } from '../telegram-file';
import { currentUpdateAbortSignal } from '../update-signal';
import { utilityModel } from './ai';
import { renderLocalPrompt } from './local-prompts';

export async function describeTelegramPhoto(
  ctx: BotContext,
  photo: PhotoSize,
): Promise<string> {
  const data = await downloadTelegramFile(ctx, photo.file_id, {
    declaredSize: photo.file_size,
  });
  const response = await generateText({
    abortSignal: currentUpdateAbortSignal(),
    model: utilityModel,
    instructions: renderLocalPrompt('image-description', {}),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            mediaType: 'image/jpeg',
            data,
          },
        ],
      },
    ],
    temperature: 0,
  });
  return response.text;
}
