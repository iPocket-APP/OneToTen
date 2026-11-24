import { createRoot } from 'react-dom/client';
import { I18nContext, loadI18n } from './i18n.tsx';
import { setDocumentLocale } from './locale.ts';
import type { Locale } from './locale.ts';
import { updatePageMetadata } from './page-metadata.ts';
import { NotFound } from './site-pages.tsx';

export async function localizeNotFound(root: HTMLElement, locale: Locale): Promise<void> {
  const i18n = await loadI18n(locale);
  setDocumentLocale(locale);
  updatePageMetadata(i18n, 'notFound');
  createRoot(root).render(<I18nContext.Provider value={i18n}><NotFound /></I18nContext.Provider>);
}
