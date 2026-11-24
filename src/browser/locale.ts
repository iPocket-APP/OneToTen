export const languages = {
  'zh-CN': { name: '简体中文', path: '', ogLocale: 'zh_CN' },
  en: { name: 'English', path: 'en', ogLocale: 'en_US' },
  es: { name: 'Español', path: 'es', ogLocale: 'es_ES' },
  'pt-BR': { name: 'Português (Brasil)', path: 'pt-br', ogLocale: 'pt_BR' },
  fr: { name: 'Français', path: 'fr', ogLocale: 'fr_FR' },
  de: { name: 'Deutsch', path: 'de', ogLocale: 'de_DE' },
  ja: { name: '日本語', path: 'ja', ogLocale: 'ja_JP' },
  ko: { name: '한국어', path: 'ko', ogLocale: 'ko_KR' },
  ru: { name: 'Русский', path: 'ru', ogLocale: 'ru_RU' },
  ar: { name: 'العربية', path: 'ar', ogLocale: 'ar_SA' },
  hi: { name: 'हिन्दी', path: 'hi', ogLocale: 'hi_IN' },
  id: { name: 'Bahasa Indonesia', path: 'id', ogLocale: 'id_ID' },
} as const;

export type Locale = keyof typeof languages;
export type PublicPage = 'home' | 'guide';
export const locales = Object.keys(languages) as Locale[];
export const defaultLocale: Locale = 'zh-CN';

export function pagePath(locale: Locale, page: PublicPage = 'home'): string {
  const slug = languages[locale].path;
  return (slug ? '/' + slug + '/' : '/') + (page === 'guide' ? 'guide' : '');
}

export function direction(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export function brandName(locale: Locale): string {
  return locale === defaultLocale ? '一传十' : 'One to Ten';
}

export function resolveLocale(value: string): Locale | undefined {
  const name = value.toLowerCase();
  return locales.find((locale) => locale.toLowerCase() === name || locale.split('-')[0] === name.split('-')[0]);
}

const preferenceKey = 'file-room:language';

export function preferredLocale(): Locale {
  try {
    const saved = resolveLocale(localStorage.getItem(preferenceKey) ?? '');
    if (saved) return saved;
  } catch { /* Storage can be disabled. */ }
  for (const language of navigator.languages ?? [navigator.language]) {
    const match = resolveLocale(language);
    if (match) return match;
  }
  return defaultLocale;
}

export function rememberLocale(locale: Locale): void {
  try { localStorage.setItem(preferenceKey, locale); } catch { /* Storage can be disabled. */ }
}

export function documentLocale(): Locale {
  return resolveLocale(document.documentElement.lang) ?? defaultLocale;
}

export function setDocumentLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = direction(locale);
}
