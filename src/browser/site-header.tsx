import React from 'react';
import { FolderOpen, LogOut } from 'lucide-react';
import { useI18n } from './i18n.tsx';
import { LanguageMenu } from './language-menu.tsx';
import type { ChangeLanguage } from './language-menu.tsx';
import { brandName, defaultLocale, pagePath } from './locale.ts';

export function SiteBrand({ link = false }: { link?: boolean }) {
  const { locale } = useI18n();
  const chinese = locale === defaultLocale;
  const content = <>
    <span className="brand-symbol"><img src="/brand-mark.png" alt="" width="192" height="192" fetchPriority="low" /></span>
    <span className="brand-names">
      <span lang={chinese ? undefined : 'en'}>{brandName(locale)}</span>
      {chinese && <span className="brand-english" lang="en">One to Ten</span>}
    </span>
  </>;
  return link ? <a className="brand brand-link" href={pagePath(locale)}>{content}</a> : <div className="brand">{content}</div>;
}

export function SiteHeader({ archiveCount = 0, openShelf, leave, isHomepage, changeLanguage }: {
  archiveCount?: number; openShelf?: () => void; leave?: { disabled: boolean; confirm: () => void };
  isHomepage?: boolean; changeLanguage?: ChangeLanguage;
}): React.JSX.Element {
  const { t, number } = useI18n();
  return <header className="site-header">
    <div className="header-inner">
      <SiteBrand />
      <div className="header-actions">
        <button type="button" className="button quiet archive-button" disabled={!openShelf} onClick={openShelf}>
          <FolderOpen size={19} /> {t('receivedFiles')}
          {archiveCount > 0 && <span className="archive-count">{number(archiveCount)}</span>}</button>
        {leave && <button className="button quiet leave-button" disabled={leave.disabled} onClick={leave.confirm}>
          <LogOut size={17} /> {t('leave')}
        </button>}
        <LanguageMenu page={isHomepage ? 'home' : undefined} changeLanguage={changeLanguage} />
      </div>
    </div>
  </header>;
}
