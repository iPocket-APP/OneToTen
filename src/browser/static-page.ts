import { defaultLocale, documentLocale, preferredLocale, rememberLocale } from './locale.ts';

const notFound = document.querySelector<HTMLElement>('#not-found');
if (!notFound) rememberLocale(documentLocale());
else {
  const locale = preferredLocale();
  if (locale !== defaultLocale) void import('./localized-not-found.tsx').then(({ localizeNotFound }) => localizeNotFound(notFound, locale));
}
