import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { routerAIToken } from '../config';

export const routerAI = createOpenAICompatible({
  name: 'routerAI',
  apiKey: routerAIToken,
  baseURL: 'https://routerai.ru/api/v1',
  supportsStructuredOutputs: true,
});

export const chatModel = routerAI('google/gemini-3.7-flash');
export const liteChatModel = routerAI('deepseek/deepseek-v4-flash');
export const utilityModel = routerAI('qwen/qwen3.7-flash');
