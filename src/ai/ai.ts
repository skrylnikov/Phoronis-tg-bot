import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { routerAIToken } from '../config';
import { chatModelId, liteChatModelId } from './model-ids';

export const routerAI = createOpenAICompatible({
  name: 'routerAI',
  apiKey: routerAIToken,
  baseURL: 'https://routerai.ru/api/v1',
  supportsStructuredOutputs: true,
});

export const chatModel = routerAI(chatModelId);
export const liteChatModel = routerAI(liteChatModelId);
export const utilityModel = routerAI('qwen/qwen3.7-flash');
