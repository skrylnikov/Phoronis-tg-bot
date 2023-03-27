import { pipe } from 'ramda';
export const cleanLinks = (text) => text
    .replace(/^(https?|chrome):\/\/[^\s$.?#].[^\s]*$/, '<link>');
export const clean = pipe(cleanLinks);
