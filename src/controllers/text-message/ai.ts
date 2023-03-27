import { Configuration, OpenAIApi } from "openai";

import { openAIToken } from '../../config'

const configuration = new Configuration({
    // organization: "YOUR_ORG_ID",
    apiKey: openAIToken,
});
const openai = new OpenAIApi(configuration);

export const askAI = async (text: string) => {
  const result = await openai.createChatCompletion({
    model: 'gpt-3.5-turbo',
    messages: [
      {
        role: 'system',
        content: 'Ты умный помоник. Ты назван в честь ИО - спутника питера',
      },
      {
        role: 'user',
        content: text,
      }
    ],
  });

  return result.data.choices[0].message?.content;
};
