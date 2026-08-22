import { tool } from 'ai';
import { z } from 'zod';
import { openWeatherToken } from '../../config';

export const weatherTool = tool({
  description: 'Получить погоду для указанного места',
  inputSchema: z.object({
    location: z.string().describe('Название города или местности'),
  }),
  execute: async (input: unknown) => {
    const { location } = input as { location: string };
    try {
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${openWeatherToken}&lang=ru&units=metric`,
      );
      if (!response.ok) {
        throw new Error(`Weather API error: ${response.statusText}`);
      }
      const data = await response.json();
      return JSON.stringify(data);
    } catch (_error) {
      return 'Не удалось получить информацию о погоде';
    }
  },
});
