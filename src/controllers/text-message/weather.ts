import { last } from 'ramda';


import { sendMessage } from '../../bl/actions';

import { IExecuteProps } from './types';

import { dadataToken, openWeatherToken } from '../../config';

import got from 'got';

export const config = {
  activateList: [['погода']],
};

export const execute = async ({ normalizedTokenList }: IExecuteProps) => {
  console.log('Weather');
  
  const url = `https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address`;

  const cityResponse = await got.post<any>(url, {
    body: JSON.stringify({
      query: last(normalizedTokenList),
      locations: [
        {
          country: "*"
        }
      ]
    }),
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      Authorization: 'Token ' + dadataToken,
    },
    responseType: 'json',
  });

  const findedCity = cityResponse.body.suggestions.find((x: any) => x.data?.city);

  const city = findedCity?.data?.city;
  const country = findedCity?.data?.country;

  if (!city) {
    return [
      sendMessage('Я не смогла тебя найти :('),
    ];
  }

  console.log(city);


  const weatherResponse = await got.get<any>(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${openWeatherToken}&lang=ru&units=metric`, { responseType: 'json' });

  const weather = weatherResponse.body;

  return [
    sendMessage(`
*${weather.name}, ${country}

${weather.weather[0].description}
Температура: ${weather.main.temp}°C
Чувствуется как: ${weather.main.feels_like}°C
Относительная влажность: ${weather.main.humidity}%
Cкорость ветра: ${weather.wind.speed} км/ч*
`, { reply: true}),
  ];
}