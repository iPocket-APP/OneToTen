import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { roomPage } from '../shared/room.ts';
import type { Session } from '../shared/room.ts';
import { Home } from './home.tsx';
import { I18nContext, loadI18n } from './i18n.tsx';
import type { I18n } from './i18n.tsx';
import { localDevice } from './labels.ts';
import { canRevealLocalFile } from './local-finder.ts';
import { documentLocale, pagePath, preferredLocale, rememberLocale, setDocumentLocale } from './locale.ts';
import type { Locale } from './locale.ts';
import { updatePageMetadata } from './page-metadata.ts';
import { clearSession, getSession, parseInvite, saveSession } from './room-client.ts';
import { deleteStored, pruneExpiredStaging, records } from './storage-model.ts';
import type { StorageProbe } from './storage-model.ts';
import type { FileReceipt, ShelfItem } from './transfers.ts';

const Workspace = lazy(() => import('./workspace.tsx'));
const loadFileViews = () => import('./ui.tsx');
const FileReceiptToast = lazy(() => loadFileViews().then(({ FileReceiptToast }) => ({ default: FileReceiptToast })));
const ReceivedFileDetails = lazy(() => loadFileViews().then(({ ReceivedFileDetails }) => ({ default: ReceivedFileDetails })));
const Shelf = lazy(() => loadFileViews().then(({ Shelf }) => ({ default: Shelf })));
const initialStorage: StorageProbe = { staging: null };

function readEntry(): { session?: Session; invitation?: ReturnType<typeof parseInvite>; error?: string } {
  const page = roomPage(location.pathname);
  if (!page) return {};
  if (page.kind === 'room') return { session: getSession(page.id) };

  // Keep the invitation secret in memory and remove it from the address bar.
  const link = location.href;
  const hasInvite = Boolean(location.hash);
  history.replaceState(null, '', '/room/' + page.id);
  if (!hasInvite) {
    const session = getSession(page.id);
    return session ? { session } : { error: 'INVALID_INVITE' };
  }
  try { return { invitation: parseInvite(link) }; }
  catch { return { error: 'INVALID_INVITE' }; }
}

const entry = readEntry();
const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
const publicOrigin = canonical ? new URL(canonical).origin : undefined;

async function checkLanHttp(): Promise<boolean> {
  if (window.isSecureContext || location.protocol !== 'http:') return false;
  try {
    const response = await fetch('/__file-room/lan-http', {
      cache: 'no-store',
      headers: { Accept: 'application/json', 'X-File-Room-Action': 'lan-http' },
    });
    if (!response.ok) return false;
    return (await response.json() as { allowed?: unknown }).allowed === true;
  } catch {
    return false;
  }
}

type FilePanel = { kind: 'shelf' } | { kind: 'details'; receipt: FileReceipt; prepare: boolean };

function App({ prerendered, initialI18n, lanHttp }: { prerendered: boolean; initialI18n: I18n; lanHttp: boolean }) {
  const roomAllowed = window.isSecureContext || lanHttp;
  const compatible = roomAllowed && typeof RTCPeerConnection === 'function' && typeof Worker === 'function' &&
    typeof window.crypto?.getRandomValues === 'function';
  const compatibility = compatible ? (lanHttp ? 'lan-http' : 'ready') : (roomAllowed ? 'unsupported' : 'insecure');
  const [i18n, setI18n] = useState(initialI18n);
  const { t, locale } = i18n;
  const [isHomepage, setIsHomepage] = useState(prerendered);
  const currentLocale = useRef(locale);
  currentLocale.current = locale;
  const [interactive, setInteractive] = useState(!prerendered);
  const [session, setSession] = useState(entry.session);
  const [invitation, setInvitation] = useState(entry.invitation);
  const [homeError, setHomeError] = useState(entry.error);
  const [archive, setArchive] = useState<ShelfItem[]>([]);
  const [filePanel, setFilePanel] = useState<FilePanel>();
  const [receipts, setReceipts] = useState<FileReceipt[]>([]);
  const [storage, setStorage] = useState<StorageProbe>();
  const [finderAvailable, setFinderAvailable] = useState(false);
  const archiveRef = useRef<ShelfItem[]>([]);
  archiveRef.current = archive;
  const currentSession = useRef(session);
  currentSession.current = session;
  const onReceived = useRef((receipt: FileReceipt, staged?: ShelfItem) => {
    if (staged) setArchive((current) => [staged, ...current.filter(({ id }) => id !== staged.id)]);
    setReceipts((current) => [receipt, ...current.filter(({ id }) => id !== receipt.id)].slice(0, 3));
  }).current;
  const dismissReceipt = useCallback((id: string) => setReceipts((list) => list.filter((receipt) => receipt.id !== id)), []);
  const memoryUsed = useRef(() => archiveRef.current.reduce((sum, { memoryFile }) => sum + (memoryFile?.size ?? 0), 0)).current;
  const exit = useRef<(code?: string) => void>((code) => {
    const current = currentSession.current;
    if (current) clearSession(current.roomId);
    setInvitation(undefined);
    history.replaceState(null, '', pagePath(currentLocale.current));
    setIsHomepage(true);
    setHomeError(code);
    setSession(undefined);
  }).current;

  useEffect(() => {
    setInteractive(true);
    void canRevealLocalFile().then(setFinderAvailable);
    if (compatible) void pruneExpiredStaging().catch(() => undefined);
    void records().then((stored) => setArchive((current) => {
      const used = new Set(current.map(({ id }) => id));
      return [...current, ...stored.filter((item) => item.digest && !used.has(item.id)).sort((a, b) => b.updatedAt - a.updatedAt)
        .map((entry) => ({ id: entry.id, file: entry.file, senderName: entry.senderName, entry }))];
    })).catch(() => undefined);
  }, []);

  useEffect(() => {
    setDocumentLocale(locale);
    rememberLocale(locale);
    if (isHomepage && location.pathname !== pagePath(locale)) {
      history.replaceState(history.state, '', pagePath(locale) + location.search + location.hash);
    }
    updatePageMetadata(i18n, isHomepage ? 'home' : 'room', publicOrigin);
  }, [i18n, isHomepage, locale]);

  async function changeLanguage(next: Locale): Promise<void> {
    setI18n(await loadI18n(next));
  }

  const needsStorage = compatible && Boolean(session || invitation || lanHttp);
  useEffect(() => {
    if (!needsStorage || storage) return;
    let active = true;
    void import('./storage.ts').then(({ probeStorage }) => probeStorage())
      .catch(() => initialStorage)
      .then((result) => { if (active) setStorage(result); });
    return () => { active = false; };
  }, [needsStorage, storage]);

  async function remove(item: ShelfItem) {
    if (item.entry) await deleteStored(item.id);
    setArchive((list) => list.filter(({ id }) => id !== item.id));
    dismissReceipt(item.id);
  }

  function open(next: Session) {
    saveSession(next);
    setSession(next);
    setIsHomepage(false);
    history.replaceState(null, '', '/room/' + next.roomId);
  }

  function openShelf() {
    setFilePanel({ kind: 'shelf' });
  }

  function openFile(receipt: FileReceipt, prepare = false) {
    dismissReceipt(receipt.id);
    setFilePanel({ kind: 'details', receipt, prepare });
  }

  const roomSession = compatible ? session : undefined;
  return <I18nContext.Provider value={i18n}>
    {roomSession ? <div className="room-page">
      <Suspense fallback={<main className="shell workspace-loading"><p role="status">{t('openingRoom')}</p></main>}>
        <Workspace key={roomSession.roomId} session={roomSession} storage={storage ?? initialStorage} exit={exit}
          onReceived={onReceived} memoryUsed={memoryUsed} archiveCount={archive.length} openShelf={openShelf} openFile={openFile}
          finderAvailable={finderAvailable} lanHttp={lanHttp} changeLanguage={changeLanguage}
          getStored={(id) => archive.find((entry) => entry.id === id)} />
      </Suspense>
    </div> : <Home device={interactive ? localDevice(t('defaultDevice')) : undefined} invitation={invitation} open={open}
      error={homeError} storage={storage} compatibility={interactive ? compatibility : undefined}
      isHomepage={isHomepage} guideOrigin={interactive ? location.origin : publicOrigin}
      archiveCount={archive.length} openShelf={interactive ? openShelf : undefined} changeLanguage={changeLanguage} />}
    {receipts.length > 0 && <ul className="receipt-notices" aria-label={t('fileNotices')} aria-live="polite" aria-relevant="additions">
      <Suspense fallback={null}>
        {receipts.map((receipt) => <FileReceiptToast key={receipt.id} receipt={receipt} open={openFile} dismiss={dismissReceipt} />)}
      </Suspense>
    </ul>}
    {filePanel && <Suspense fallback={<p className="visually-hidden" role="status">{t('openingFiles')}</p>}>
      {filePanel.kind === 'shelf' ?
        <Shelf items={archive} close={() => setFilePanel(undefined)} remove={remove} finderAvailable={finderAvailable} /> :
        <ReceivedFileDetails key={filePanel.receipt.id} receipt={filePanel.receipt}
          staged={archive.find(({ id }) => id === filePanel.receipt.id)} prepare={filePanel.prepare}
          close={() => setFilePanel(undefined)} remove={remove} finderAvailable={finderAvailable} />}
    </Suspense>}
  </I18nContext.Provider>;
}

const root = document.getElementById('root')!;
const prerendered = Boolean(root.firstElementChild);
const locale = prerendered ? documentLocale() : preferredLocale();
void Promise.all([loadI18n(locale), checkLanHttp()]).then(([initialI18n, lanHttp]) => {
  const app = <App prerendered={prerendered} initialI18n={initialI18n} lanHttp={lanHttp} />;
  if (prerendered) hydrateRoot(root, app);
  else {
    setDocumentLocale(locale);
    createRoot(root).render(app);
  }
});
