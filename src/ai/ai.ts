import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { routerAIToken } from '../config';

export const routerAI = createOpenAICompatible({
  name: 'routerAI',
  apiKey: routerAIToken,
  baseURL: 'https://routerai.ru/api/v1',
  supportsStructuredOutputs: true,
});

export const chatModel = routerAI('google/gemini-3.6-flash');
export const utilityModel = routerAI('nex-agi/nex-n2-mini');
