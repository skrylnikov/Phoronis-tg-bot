import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel } from 'ai';
import { routerAIToken } from '../config';
import {
  chatModelId,
  liteChatModelId,
  liteChatReasoningEffort,
  utilityModelId,
  utilityReasoningEffort,
} from './model-ids';

export const routerAI = createOpenAICompatible({
  name: 'routerAI',
  apiKey: routerAIToken,
  baseURL: 'https://routerai.ru/api/v1',
  supportsStructuredOutputs: true,
});

function modelWithReasoning(modelId: string, reasoningEffort: string) {
  return wrapLanguageModel({
    model: routerAI(modelId),
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          routerAI: {
            ...params.providerOptions?.routerAI,
            reasoningEffort,
          },
        },
      }),
    },
  });
}

export const chatModel = routerAI(chatModelId);
export const liteChatModel = modelWithReasoning(
  liteChatModelId,
  liteChatReasoningEffort,
);
export const utilityModel = modelWithReasoning(
  utilityModelId,
  utilityReasoningEffort,
);
