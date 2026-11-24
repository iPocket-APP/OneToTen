import { createContext, Fragment, useContext } from 'react';
import type { ReactNode } from 'react';
import { MAX_BATCH_FILES, ROOM_CAPACITY } from '../shared/room.ts';
import { direction } from './locale.ts';
import type { Locale } from './locale.ts';
import type { Messages } from './locales/zh-CN.ts';

export type MessageKey = keyof Messages['text'];
export type MessageValues = Readonly<Record<string, string | number>>;

const catalogs = {
  'zh-CN': () => import('./locales/zh-CN.ts'),
  en: () => import('./locales/en.ts'),
  es: () => import('./locales/es.ts'),
  'pt-BR': () => import('./locales/pt-BR.ts'),
  fr: () => import('./locales/fr.ts'),
  de: () => import('./locales/de.ts'),
  ja: () => import('./locales/ja.ts'),
  ko: () => import('./locales/ko.ts'),
  ru: () => import('./locales/ru.ts'),
  ar: () => import('./locales/ar.ts'),
  hi: () => import('./locales/hi.ts'),
  id: () => import('./locales/id.ts'),
} satisfies Record<Locale, () => Promise<{ default: Messages }>>;

export async function loadI18n(locale: Locale) {
  const { default: messages } = await catalogs[locale]();
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format;
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format;
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format;
  const decimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format;
  const precise = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format;
  const seconds = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format;
  const percent = new Intl.NumberFormat(locale, { style: 'percent' }).format;
  const rtl = direction(locale) === 'rtl';

  function format(message: string, values: MessageValues): string {
    return message.replace(/\{(\w+)\}/g, (match, key: string) => {
      if (!Object.hasOwn(values, key)) return match;
      const value = values[key];
      return typeof value === 'number' ? number(value) : rtl ? '\u2068' + value + '\u2069' : value;
    });
  }

  return {
    locale, messages, number, clock, dateTime, percent,
    countdown: (value: number) => number(Math.floor(value / 60)) + ':' + seconds(value % 60),
    t: (key: MessageKey, values?: MessageValues) => values ? format(messages.text[key], values) : messages.text[key],
    feedback(code: string): string {
      const key = Object.hasOwn(messages.errors, code) ? code as keyof Messages['errors'] : 'UNKNOWN';
      return format(messages.errors[key], { capacity: ROOM_CAPACITY, count: MAX_BATCH_FILES });
    },
    sizeText(size: number): string {
      if (size < 1024) return number(size) + ' B';
      if (size < 1024 ** 2) return (size < 10240 ? decimal : number)(size / 1024) + ' KiB';
      if (size < 1024 ** 3) return (size < 10 * 1024 ** 2 ? decimal : number)(size / 1024 ** 2) + ' MiB';
      return precise(size / 1024 ** 3) + ' GiB';
    },
  };
}

export type I18n = Awaited<ReturnType<typeof loadI18n>>;
export const I18nContext = createContext<I18n | null>(null);

export function useI18n(): I18n {
  const i18n = useContext(I18nContext);
  if (!i18n) throw new Error('Missing language provider');
  return i18n;
}

export function withMarkup(message: string, slots: Readonly<Record<string, ReactNode>>): ReactNode {
  return message.split(/\{(\w+)\}/g).map((part, index) => index % 2 ?
    <Fragment key={index}>{slots[part]}</Fragment> : part);
}
