import { useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { useI18n } from './i18n.tsx';
import { direction, languages, locales, pagePath } from './locale.ts';
import type { Locale, PublicPage } from './locale.ts';

export type ChangeLanguage = (locale: Locale) => Promise<void>;

export function LanguageMenu({ page, changeLanguage }: { page?: PublicPage; changeLanguage?: ChangeLanguage }) {
  const { locale, t } = useI18n();
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  function close() {
    if (details.current) details.current.open = false;
    summary.current?.focus();
  }

  async function choose(next: Locale) {
    if (loading || !changeLanguage) return;
    setFailed(false);
    setLoading(true);
    try {
      if (next !== locale) await changeLanguage(next);
      close();
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }

  return <details className="language-menu" ref={details} onKeyDown={(event) => {
    if (event.key === 'Escape' && details.current?.open) { event.preventDefault(); close(); }
  }}>
    <summary className="button quiet" ref={summary} aria-label={t('language')} title={t('language')}>
      <Globe size={19} aria-hidden="true" /><span>{languages[locale].name}</span>
    </summary>
    <nav className="language-options" aria-label={t('language')} aria-busy={loading}>
      <ul>{locales.map((next) => <li key={next}>
        {page ? <a href={pagePath(next, page)} hrefLang={next} lang={next} dir={direction(next)}
          aria-current={locale === next ? 'page' : undefined} onClick={changeLanguage ? (event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            void choose(next);
          } : undefined}>{languages[next].name}</a> :
          <button type="button" lang={next} dir={direction(next)} disabled={loading} aria-pressed={locale === next}
            onClick={() => void choose(next)}>{languages[next].name}</button>}
      </li>)}</ul>
      {failed && <p role="status">{t('languageUnavailable')}</p>}
    </nav>
  </details>;
}
