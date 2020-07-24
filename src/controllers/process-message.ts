import { Context, } from 'telegraf';
import { pipe, intersection } from 'ramda';
import got from 'got';

import { activateWordList, openWeatherToken } from '../config';


const sendAchievement = (ctx: Context, achievement: string, level: number) => {
  ctx.reply(`${ctx.from?.username ? ('@' + ctx.from?.username) : ctx.from?.first_name} получает '${achievement}' ${level}го уровня`,
    {
      reply_to_message_id: ctx.message?.message_id,
    });
};


export const processMessageController = async (ctx: Context) => {
  if (!ctx.from || !ctx.from.id || !ctx.chat || !ctx.chat.id || !ctx.message || ctx.message.forward_from) {
    return;
  }
  const chatId = ctx.chat.id
  const id = ctx.from.id;
  const message = ctx.message;

  const { text } = message;

  if (!text) {
    return;
  }


  const wordList = text.toLowerCase().replace(/^(https?|chrome):\/\/[^\s$.?#].[^\s]*$/, '').split(/\s|\.|,|!|\?|[0-9]/).filter((x) => x.length !== 0);


  const hasActivate = intersection(activateWordList, wordList).length !== 0;

  if (!hasActivate) {
    return;
  }

  console.log(wordList);

  try {


    switch (true) {
      case wordList.includes('погода'): {
        const pureWordList = wordList.filter((x) => !activateWordList.includes(x) && x !== 'погода');

        if (pureWordList.length === 0) {
          ctx.reply('Кажется я не смогла разобрать твой почерк :(');
          return;
        }

        const [weatherResponse] = await Promise.all([
          got.get(
            `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(pureWordList.join(' '))}&appid=${openWeatherToken}&lang=ru&units=metric`,
            { responseType: 'json' }),
          ctx.replyWithChatAction('typing'),
        ]);

        const weather = weatherResponse.body as any;

        // const [cityResponse] = await Promise.all([
        //   got.get(
        //     `http://dataservice.accuweather.com/locations/v1/cities/autocomplete?apikey=${openWeatherToken}&q=${encodeURIComponent(pureWordList.join(' '))}&language=ru-ru`,
        //     {responseType: 'json' }),
        //   ctx.replyWithChatAction('typing'),
        // ]);

        // const cityResult = cityResponse.body as any;

        // const city = cityResult[0];
        // console.log(city);

        // const cityKey = cityResult[0]?.Key;

        // const weatherResponse = await got.get(`http://dataservice.accuweather.com/currentconditions/v1/${cityKey}?apikey=${openWeatherToken}&language=ru-ru&details=true`, {responseType: 'json' });

        // const weatherBody = weatherResponse.body as any;

        // const weather = weatherBody[0];

        //         ctx.reply(`
        //         *${weather.LocalizedName}, ${weather.Country.LocalizedName}

        // ${weather.WeatherText}
        // Температура: ${weather.Temperature.Metric.Value}°C
        // Чувствуется как: ${weather.RealFeelTemperature.Metric.Value}°C
        // Относительная влажность: ${weather.RelativeHumidity}%
        // Направление/скорость ветра: ${weather.Wind.Direction.Localized}/${weather.Wind.Speed.Metric.Value} км/ч*"
        //         `, { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id });

        ctx.reply(`
*${weather.name}

${weather.weather[0].description}
Температура: ${weather.main.temp}°C
Чувствуется как: ${weather.main.feels_like}°C
Относительная влажность: ${weather.main.humidity}%
Cкорость ветра: ${weather.wind.speed} км/ч*
`, { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id });
        return;
      }
      case (wordList.includes('раскажи') || wordList.includes('расскажи')) && wordList.includes('себе'): {
        ctx.reply(`Привет, меня зовут ИО, но ты можешь называть меня Форонида :)
Я ещё совсем маленькая и только учусь.
Но у же сейчас я умею показывать погоду, просто напиши 'ио погода Санкт-Петербург'`,
          { reply_to_message_id: ctx.message?.message_id });
        return;
      }
      default: {
        ctx.reply('Я тут', { reply_to_message_id: ctx.message?.message_id });

        return;
      }
    }


  } catch (e) {
    ctx.reply('Кажется я упала :(', { reply_to_message_id: ctx.message?.message_id });
    console.error(e);
  }
}