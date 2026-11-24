import { INVITE_TTL, ROOM_CAPACITY } from '../shared/room.ts';
import { useI18n, withMarkup } from './i18n.tsx';
import { LanguageMenu } from './language-menu.tsx';
import { brandName, pagePath } from './locale.ts';
import { SiteFooter } from './site-footer.tsx';
import { SiteBrand } from './site-header.tsx';

export function Guide() {
  const { locale, t } = useI18n();
  const home = pagePath(locale);
  return <>
    <header className="site-header">
      <div className="header-inner">
        <SiteBrand link />
        <div className="header-actions">
          <a className="button secondary" href={home}>{t('openTool')}</a>
          <LanguageMenu page="guide" />
        </div>
      </div>
    </header>
    <main className="shell guide">
      <h1 className="marked-heading">{t('guideTitle')}</h1>
      <p className="home-intro">{t('guideIntro')}</p>
      <section aria-labelledby="how-to-send">
        <h2 id="how-to-send">{t('guideSend')}</h2>
        <ol>
          <li>{withMarkup(t('guideSendStep1', { capacity: ROOM_CAPACITY }), { site: <a href={home}>{brandName(locale)}</a> })}</li>
          <li>{t('guideSendStep2', { minutes: INVITE_TTL / 60_000 })}</li>
          <li>{t('guideSendStep3')}</li>
        </ol>
      </section>
      <section aria-labelledby="save-files">
        <h2 id="save-files">{t('guideSave')}</h2>
        <p>{t('guideSaveOptions')}</p>
        <p>{t('guideResume')}</p>
      </section>
      <section aria-labelledby="connection-help">
        <h2 id="connection-help">{t('guideTroubleshoot')}</h2>
        <ul>
          <li>{t('guideTroubleshoot1')}</li>
          <li>{t('guideTroubleshoot2')}</li>
          <li>{t('guideTroubleshoot3')}</li>
        </ul>
      </section>
      <section aria-labelledby="file-privacy">
        <h2 id="file-privacy">{t('guidePrivacy')}</h2>
        <p>{t('guidePrivacyDetail')}</p>
      </section>
    </main>
    <SiteFooter />
  </>;
}

export function NotFound() {
  const { t, locale } = useI18n();
  return <>
    <main className="shell guide">
      <h1 className="marked-heading">{t('notFound')}</h1>
      <p className="home-intro">{t('notFoundDetail')}</p>
      <p><a className="button secondary" href={pagePath(locale)}>{t('backToSite')}</a></p>
    </main>
    <SiteFooter />
  </>;
}
