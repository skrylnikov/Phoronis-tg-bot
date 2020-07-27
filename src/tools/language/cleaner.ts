import { pipe } from 'ramda';

export const cleanLinks = (text: string) => text
  .replace(/^(https?|chrome):\/\/[^\s$.?#].[^\s]*$/, '<link>');

export const clean = pipe(
  cleanLinks,
);