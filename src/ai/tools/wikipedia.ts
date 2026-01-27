import { WikipediaQueryRun } from '@langchain/community/tools/wikipedia_query_run';
import { tool } from 'ai';
import { z } from 'zod';


export const wikipediaTool = tool({
  description: 'Поиск информации в Википедии на русском языке',
  inputSchema: z.object({
    query: z.string().describe('Поисковый запрос'),
  }),
  execute: async (input: unknown) => {
    const { query } = input as { query: string };
    const wikiTool = new WikipediaQueryRun({
      topKResults: 3,
      maxDocContentLength: 4000,
      baseUrl: 'https://ru.wikipedia.org/w/api.php',
    });
    return await wikiTool.invoke(query);
  },
});