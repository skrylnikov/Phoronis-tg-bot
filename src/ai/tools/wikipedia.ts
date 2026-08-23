import { tool } from 'ai';
import { z } from 'zod';

async function searchWikipedia(query: string): Promise<string> {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.searchParams.append('action', 'query');
  url.searchParams.append('list', 'search');
  url.searchParams.append('srsearch', query);
  url.searchParams.append('srlimit', '3');
  url.searchParams.append('format', 'json');
  url.searchParams.append('utf8', '1');

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Wikipedia API error: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    query?: {
      search?: Array<{ title: string }>;
    };
  };
  const results = data.query?.search || [];

  if (results.length === 0) {
    return `No results found for "${query}"`;
  }

  const summaries = await Promise.all(
    results.slice(0, 3).map(async (result: { title: string }) => {
      const extractUrl = new URL('https://en.wikipedia.org/w/api.php');
      extractUrl.searchParams.append('action', 'query');
      extractUrl.searchParams.append('titles', result.title);
      extractUrl.searchParams.append('prop', 'extracts');
      extractUrl.searchParams.append('exintro', '1');
      extractUrl.searchParams.append('explaintext', '1');
      extractUrl.searchParams.append('exchars', '1200');
      extractUrl.searchParams.append('format', 'json');

      const extractResponse = await fetch(extractUrl.toString());
      if (!extractResponse.ok) return null;

      const extractData = (await extractResponse.json()) as {
        query?: {
          pages?: Record<string, { title?: string; extract?: string }>;
        };
      };
      const pages = extractData.query?.pages || {};
      const page = Object.values(pages)[0] as {
        title?: string;
        extract?: string;
      };

      return page?.extract ? `${page.title}\n\n${page.extract}` : null;
    }),
  );

  return summaries.filter(Boolean).join('\n\n---\n\n');
}

export const wikipediaTool = tool({
  description: 'Поиск информации в Википедии на английсом языке',
  inputSchema: z.object({
    query: z.string().describe('Поисковый запрос'),
  }),
  execute: async (input: unknown) => {
    const { query } = input as { query: string };
    return await searchWikipedia(query);
  },
});
