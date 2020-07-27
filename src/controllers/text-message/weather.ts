import { last } from 'ramda';

import { IExecuteProps } from './types';

import { dadataToken, openWeatherToken } from '../../config';

import got from 'got';

export const config = {
  activateList: [['погода']],
};

export const execute = async ({ normalizedTokenList }: IExecuteProps) =>{
  const url = `https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address`;
  
  const cityResponse = await got.post<any>(url, {
    body: JSON.stringify({
      query: last(normalizedTokenList),
    }),
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      Authorization: 'Token ' + dadataToken,
    },
    responseType: 'json',
   });

   const city = cityResponse.body.suggestions[0]?.data?.city;
   const country = cityResponse.body.suggestions[0]?.data?.country;
    
   if(!city){
     return 'Я не смогла тебя найти :(';
   }

   console.log(city);
   

   const weatherResponse = await got.get<any>(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${openWeatherToken}&lang=ru&units=metric`, {responseType: 'json' });

   const weather = weatherResponse.body;

   return `
*${weather.name}, ${country}

${weather.weather[0].description}
Температура: ${weather.main.temp}°C
Чувствуется как: ${weather.main.feels_like}°C
Относительная влажность: ${weather.main.humidity}%
Cкорость ветра: ${weather.wind.speed} км/ч*
`;
}