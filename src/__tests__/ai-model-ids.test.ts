import { describe, expect, it } from 'vitest';
import {
  chatModelId,
  liteChatModelId,
  liteChatReasoningEffort,
  utilityModelId,
  utilityReasoningEffort,
} from '../ai/model-ids';

describe('AI model configuration', () => {
  it('uses the selected model IDs and reasoning levels', () => {
    expect(chatModelId).toBe('google/gemini-3.8-flash');
    expect(liteChatModelId).toBe('openai/gpt-6-luna');
    expect(liteChatReasoningEffort).toBe('medium');
    expect(utilityModelId).toBe('openai/gpt-6-luna');
    expect(utilityReasoningEffort).toBe('low');
  });
});
