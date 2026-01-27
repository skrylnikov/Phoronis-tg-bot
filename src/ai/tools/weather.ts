import { tool } from 'ai';
import axios from 'axios';
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
      const weatherResponse = await axios.get<unknown>(
        `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${openWeatherToken}&lang=ru&units=metric`,
        { responseType: 'json' },
      );
      return JSON.stringify(weatherResponse.data);
    } catch (error) {
      return 'Не удалось получить информацию о погоде';
    }
  },
});
