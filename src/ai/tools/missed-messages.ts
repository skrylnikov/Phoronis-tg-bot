import type { BotContext } from '../../bot';
import {
  canUseChatHistoryTool,
  createChatHistoryTool,
  searchChatHistory,
} from './chat-history';

export const canUseMissedMessagesTool = canUseChatHistoryTool;
export const createMissedMessagesTool = createChatHistoryTool;

export function getMissedMessages(
  ctx: BotContext | undefined,
  rawInput: unknown,
): Promise<string> {
  const input =
    rawInput && typeof rawInput === 'object'
      ? { ...(rawInput as Record<string, unknown>), mode: 'recent' }
      : { mode: 'recent' };
  return searchChatHistory(ctx, input);
}
