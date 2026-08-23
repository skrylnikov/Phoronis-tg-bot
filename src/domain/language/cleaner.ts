export const cleanLinks = (text: string) =>
  text.replace(/^(https?|chrome):\/\/[^\s$.?#].[^\s]*$/, '<link>');

export const clean = cleanLinks;
