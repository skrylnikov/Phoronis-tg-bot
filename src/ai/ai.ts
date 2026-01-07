
// import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
// import { llamaGateToken, llamaGateBaseURL, openRouterToken } from '../config';
import { openRouterToken } from '../config';


// export const llamaGate = createOpenAICompatible({
//   name: 'llamaGate',
//   apiKey: llamaGateToken,
//   baseURL: llamaGateBaseURL,
//   includeUsage: true, // Include usage information in streaming responses
//   fetch: (input, init) => {
//     console.log(input),
//     console.log(init)

//     return fetch(input, init)
//   }
// });

export const openRouter = createOpenRouter({
  apiKey: openRouterToken,
})

export const textBeautifierModel = openRouter('google/gemini-2.5-flash-lite')

