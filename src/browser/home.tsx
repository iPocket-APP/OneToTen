import React, { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowDown, ArrowRight, File, PanelTop, Plus, Shield } from 'lucide-react';
import { MAX_DEVICE_NAME_LENGTH } from '../shared/room.ts';
import type { Device, Session } from '../shared/room.ts';
import { AgentGuide } from './agent-guide.tsx';
import { useI18n, withMarkup } from './i18n.tsx';
import { codeOf } from './labels.ts';
import type { ChangeLanguage } from './language-menu.tsx';
import { pagePath } from './locale.ts';
import { INDEXED_DB_LIMIT, MEMORY_LIMIT } from './protocol.ts';
import { createRoom, joinRoom, parseInvite } from './room-client.ts';
import { SiteFooter } from './site-footer.tsx';
import { SiteHeader } from './site-header.tsx';
import type { StorageProbe } from './storage-model.ts';

interface HomeProps {
  device?: Device;
  invitation?: ReturnType<typeof parseInvite>;
  error?: string;
  storage?: StorageProbe;
  compatibility?: 'ready' | 'lan-http' | 'insecure' | 'unsupported';
  open?: (session: Session) => void;
  archiveCount?: number;
  openShelf?: () => void;
  isHomepage?: boolean;
  guideOrigin?: string;
  changeLanguage?: ChangeLanguage;
}

export function Home({ device, invitation, open, error, storage, compatibility, archiveCount, openShelf,
  isHomepage = true, guideOrigin, changeLanguage }: HomeProps): React.JSX.Element {
  const { t, feedback, sizeText, locale } = useI18n();
  const [editedName, setName] = useState<string>();
  const name = editedName ?? device?.name ?? '';
  const [link, setLink] = useState('');
  const [invite, setInvite] = useState(invitation);
  const [mode, setMode] = useState<'create' | 'join'>(invitation ? 'join' : 'create');
  const [notice, setNotice] = useState(error ?? '');
  const [busy, setBusy] = useState(false);
  const compatible = compatibility === 'ready' || compatibility === 'lan-http';
  const showAgentGuide = isHomepage && !invite;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!device || !open || !compatible) return;
    setNotice('');
    setBusy(true);
    try {
      const self = { ...device, name: name.trim() };
      if (mode === 'join') {
        const entered = invite ?? parseInvite(link);
        open(await joinRoom(entered.roomId, self, entered.secret));
      } else {
        open(await createRoom(self));
      }
    } catch (error) {
      setNotice(codeOf(error));
    } finally {
      setBusy(false);
    }
  }

  function changeMode(next: 'create' | 'join') {
    setMode(next);
    setNotice('');
    if (next === 'create') setInvite(undefined);
  }

  return <>
    <SiteHeader archiveCount={archiveCount} openShelf={openShelf} isHomepage={isHomepage} changeLanguage={changeLanguage} />
    <main className="home shell">
      <div className="home-heading">
        <h1 className="marked-heading">{t(invite ? 'joinRoom' : 'homeTitle')}</h1>
        <p className="home-intro">{t(invite ? 'joinIntro' : 'homeIntro')}</p>
        {showAgentGuide && <a className="agent-guide-link" href="#agent-guide">
          {t('agentGuide')} <ArrowDown size={15} aria-hidden="true" />
        </a>}
      </div>
      <div className="paper-ticket home-ticket">
        <div className="ticket-paper" aria-hidden="true" />
        <div className="ticket-content home-content">
          <div className="switcher" role="group" aria-label={t('roomEntry')}>
            <button type="button" disabled={!device} className={mode === 'create' ? 'current' : ''} aria-pressed={mode === 'create'}
              onClick={() => changeMode('create')}>{t('create')}</button>
            <button type="button" disabled={!device} className={mode === 'join' ? 'current' : ''} aria-pressed={mode === 'join'}
              onClick={() => changeMode('join')}>{t('join')}</button>
          </div>
          <form method="post" className="entry-form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="device-name">{t('deviceName')}</label>
            <input id="device-name" name="device-name" autoComplete="off" dir="auto" value={name} maxLength={MAX_DEVICE_NAME_LENGTH}
              required disabled={!device} onChange={(event) => setName(event.currentTarget.value)} />
            {mode === 'join' && !invite && <>
              <label htmlFor="invite-link">{t('invitationLink')}</label>
              <input id="invite-link" name="invite-link" placeholder={t('invitationPlaceholder')} dir="auto" value={link} required
                autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setLink(event.currentTarget.value)} />
            </>}
            <button className="button primary entry-action" disabled={busy || !compatible || !name.trim()}>
              {mode === 'create' ? <Plus size={20} /> : <ArrowRight size={20} />}
              {t(busy ? 'connecting' : mode === 'create' ? 'createRoom' : 'joinRoom')}
            </button>
            {notice && <p className="notice" role="alert">{feedback(notice)}</p>}
            {(compatibility === 'insecure' || compatibility === 'unsupported') && <p className="notice" role="alert">
              {t(compatibility === 'unsupported' ? 'useWebRTC' : 'useHttps')}</p>}
            {compatibility === 'lan-http' && storage && <p className="entry-note muted">{storage.staging === 'indexed-db' ?
              t('lanDisk', { size: sizeText(INDEXED_DB_LIMIT) }) : t('lanMemory', { size: sizeText(MEMORY_LIMIT) })}</p>}
          </form>
        </div>
        <figure className="ticket-stub diagram" aria-label={t('connectionDiagram')}>
          <div className="diagram-tiles" aria-hidden="true">
            <span className="diagram-node"><PanelTop size={48} /></span>
            <span className="diagram-link"><i /><span className="diagram-file"><File size={24} /></span><i /></span>
            <span className="diagram-node"><PanelTop size={48} /></span>
          </div>
          <figcaption><Shield size={16} aria-hidden="true" /> {t('directCaption')}</figcaption>
        </figure>
      </div>
      {!invite && <section className="home-help" aria-labelledby="home-help-title">
        <h2 id="home-help-title">{t('homeHelp')}</h2>
        <p>{t('homeHelpSteps')}</p>
        <p>{withMarkup(t('homeHelpMore'), { guide: <a href={pagePath(locale, 'guide')}>{t('guideLink')}</a> })}</p>
      </section>}
      {showAgentGuide && <AgentGuide origin={guideOrigin} interactive={Boolean(device)} />}
    </main>
    <SiteFooter />
  </>;
}
