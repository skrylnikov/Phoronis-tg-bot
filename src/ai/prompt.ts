import type { ModelMessage, SystemModelMessage } from 'ai';

type ConversationMessage = Exclude<ModelMessage, SystemModelMessage>;

export function splitSystemMessages(messages: ModelMessage[]): {
  instructions: SystemModelMessage[] | undefined;
  messages: ConversationMessage[];
} {
  const instructions: SystemModelMessage[] = [];
  const conversationMessages: ConversationMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      instructions.push(message);
    } else {
      conversationMessages.push(message);
    }
  }

  return {
    instructions: instructions.length > 0 ? instructions : undefined,
    messages: conversationMessages,
  };
}
