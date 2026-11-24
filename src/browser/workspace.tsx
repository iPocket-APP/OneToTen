import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import {
  ArrowLeftRight, ArrowUp, Check, ChevronRight, Copy, File, Link2, MessageSquare,
  Paperclip, Pencil, RefreshCw, ScanLine, Shield, Users, X,
} from 'lucide-react';
import { INVITE_TTL, MAX_BATCH_FILES, ROOM_CAPACITY, randomId } from '../shared/room.ts';
import type { Invite, Member, RoomEvent, Session, ShareSummary } from '../shared/room.ts';
import invitationArrow from './assets/invitation-arrow.webp';
import { useI18n } from './i18n.tsx';
import type { MessageKey, MessageValues } from './i18n.tsx';
import { codeOf } from './labels.ts';
import type { ChangeLanguage } from './language-menu.tsx';
import { Pairs } from './pairs.ts';
import { textTooLong } from './protocol.ts';
import type { SaveMode } from './protocol.ts';
import { api, inviteLink, renameMember, RoomClient, saveSession } from './room-client.ts';
import type { SignalStatus } from './room-client.ts';
import { SiteFooter } from './site-footer.tsx';
import { SiteHeader } from './site-header.tsx';
import type { StorageProbe } from './storage-model.ts';
import { browserStorage, hasSavePicker } from './storage.ts';
import { TextTransfers } from './text-transfers.ts';
import type { TextTransfer } from './text-transfers.ts';
import { Transfers } from './transfers.ts';
import type { FileReceipt, ShelfItem, TransferView } from './transfers.ts';
import { DeviceIcon, Modal, RenameDeviceDialog, TextTransferRow, TransferRow } from './ui.tsx';
import './room.css';

type RoomExit = (code?: string) => void;
const stun = import.meta.env.VITE_ROOM_STUN_URL as string | undefined;
const rtcConfig: RTCConfiguration = { iceServers: stun?.startsWith('stun:') ? [{ urls: stun }] : [] };

function InvitationPanel({ invite, room, now, busy, rotate }: {
  invite: Invite; room: string; now: number; busy: boolean; rotate: () => void;
}) {
  const { t, countdown } = useI18n();
  const active = now < invite.expiresAt;
  const url = active ? inviteLink(room, invite) : '';
  const [qr, setQR] = useState<{ url: string; image: string }>();
  const [copyState, setCopy] = useState('');
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    void import('qrcode').then(({ default: qrCode }) => qrCode.toDataURL(url, {
      scale: 6, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#30241a', light: '#ffffff' },
    }))
      .then((image) => { if (!cancelled) setQR({ url, image }); })
      .catch(() => { if (!cancelled) setFallback(true); });
    return () => { cancelled = true; };
  }, [url]);
  const localOnly = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  const canCopy = typeof navigator.clipboard?.writeText === 'function';
  const seconds = Math.max(0, Math.ceil((invite.expiresAt - now) / 1000));
  const remaining = countdown(seconds);

  async function copy() {
    if (!canCopy) {
      setFallback(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopy(url);
      window.setTimeout(() => setCopy((previous) => previous === url ? '' : previous), 1800);
    } catch { setFallback(true); }
  }

  return <section className="paper-ticket invite-panel" aria-labelledby="invite-title">
    <div className="ticket-paper" aria-hidden="true" />
    <div className="ticket-content invite-details">
      <h2 id="invite-title" className="marked-heading">{t('scanToJoin')}</h2>
      <p className="invite-description">{t('scanWithCamera')}</p>
      <div className="invite-actions">
        <button className="button secondary" disabled={!active} onClick={() => void copy()}>
          {copyState === url && active ? <Check size={19} /> : <Copy size={19} />}
          {t(copyState === url && active ? 'copied' : canCopy ? 'copyInvite' : 'showInvite')}
        </button>
        <button className="icon-button" disabled={busy} onClick={rotate} aria-label={t('renewInvite')} title={t('renewInvite')}>
          <RefreshCw size={21} />
        </button>
      </div>
      {fallback && active && <input readOnly dir="ltr" aria-label={t('invitationLink')} value={url} onFocus={(event) => event.currentTarget.select()} />}
      {localOnly && <p className="invite-local">{t('localInvite')}</p>}
    </div>
    {active && <img className="invite-arrow" src={invitationArrow} alt="" width="350" height="100" />}
    <div className="ticket-stub invite-stub">
      <div className="qr">
        {active && qr?.url === url ? <img src={qr.image} alt={t('inviteQr')} width="248" height="248" /> :
          <div className="qr-placeholder"><ScanLine size={30} /><span>{t(active ? 'generatingQr' : 'invitationExpired')}</span></div>}
      </div>
      <p className="qr-time">{active ? t('inviteRemaining', { time: remaining }) : t('inviteRenewHint')}</p>
    </div>
  </section>;
}

interface Engine { client: RoomClient; pairs: Pairs; transfers: Transfers; texts: TextTransfers }
interface Published { id: string; files: File[]; expiresAt: number }
interface ShareRequest { shareId: string; from: string }
type Confirmation = { type: 'end' | 'leave' } | { type: 'kick'; peer: Member } | { type: 'publish' };
type SendResult = { key: MessageKey; values?: MessageValues } | { code: string; attachmentsQueued?: boolean };

export default function Workspace({ session, storage, exit, onReceived, memoryUsed, archiveCount, openShelf, openFile, getStored,
  finderAvailable, lanHttp, changeLanguage }: {
  session: Session; storage: StorageProbe; exit: RoomExit; onReceived: (receipt: FileReceipt, staged?: ShelfItem) => void;
  memoryUsed: () => number; archiveCount: number; openShelf: () => void; openFile: (receipt: FileReceipt, prepare: boolean) => void;
  getStored: (id: string) => ShelfItem | undefined; finderAvailable: boolean; lanHttp: boolean;
  changeLanguage: ChangeLanguage;
}) {
  const { t, clock, number, feedback, sizeText } = useI18n();
  const [members, setMembers] = useState<Member[]>([]);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [jobs, setJobs] = useState<TransferView[]>([]);
  const [texts, setTexts] = useState<TextTransfer[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<SendResult>();
  const [status, setStatus] = useState<SignalStatus>('connecting');
  const [invite, setInvite] = useState(session.invite);
  const [expiresAt, setExpiresAt] = useState(session.roomExpiresAt);
  const [recipient, setRecipient] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<{ code: string } | { key: MessageKey }>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [renameOpen, setRenameOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [audience, setAudience] = useState('');
  const [requests, setRequests] = useState<ShareRequest[]>([]);
  const engine = useRef<Engine>(null);
  const online = useRef<Member[]>([]);
  const ownExit = useRef(false);
  const sendInFlight = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const published = useRef<Published>(null);
  const probe = useRef(storage);
  probe.current = storage;

  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (published.current && published.current.expiresAt <= current) published.current = null;
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const getPeer = (id: string) => online.current.find((member) => member.id === id);
    const handle = (event: RoomEvent) => {
      switch (event.type) {
        case 'room.snapshot':
          online.current = event.members;
          setMembers(event.members);
          setShares(event.shares);
          setExpiresAt(event.expiresAt);
          pairs.membersChanged(event.members);
          return;
        case 'room.revoked':
          pairs.closePeer(event.peerId, 'MEMBER_REVOKED');
          transfers.revoke(event.peerId);
          return;
        case 'room.closed':
          client.destroy();
          transfers.destroy(event.code);
          pairs.destroy(event.code);
          exit(ownExit.current ? undefined : event.code);
          return;
        case 'share.request':
          if (published.current?.id === event.shareId) setRequests((current) => current.some((entry) =>
            entry.shareId === event.shareId && entry.from === event.from) ? current :
            [...current, { shareId: event.shareId, from: event.from }]);
          return;
        case 'error':
          if (event.code === 'ROOM_CLOSED') handle({ type: 'room.closed', code: event.code });
          else if (event.peerId) pairs.closePeer(event.peerId, event.code);
          else setNotice({ code: event.code });
          return;
        default:
          pairs.signal(event);
      }
    };
    const client = new RoomClient(session, handle, setStatus);
    const pairs = new Pairs(client, getPeer, {
      control: (pair, message) => {
        if (message.type === 'text.message' || message.type === 'text.ack') textTransfers.control(pair, message);
        else transfers.control(pair, message);
      },
      bulk: (pair, data) => transfers.bulk(pair, data),
      close: (pair, code) => {
        textTransfers.pairClosed(pair, code);
        transfers.pairClosed(pair, code);
      },
      modes: () => {
        const modes: SaveMode[] = ['memory'];
        if (hasSavePicker()) modes.push('direct');
        if (probe.current.staging) modes.push(probe.current.staging);
        return modes;
      },
      text: true,
    }, () => new RTCPeerConnection(rtcConfig));
    const transfers = new Transfers(session, {
      connect: (id) => pairs.ensure(id), peer: getPeer, onChange: setJobs, onReceived, memoryUsed, storage: browserStorage,
    });
    const textTransfers = new TextTransfers((id) => pairs.ensure(id), setTexts);
    engine.current = { client, pairs, transfers, texts: textTransfers };
    client.start();
    return () => {
      client.destroy();
      transfers.destroy('PAGE_CLOSED');
      pairs.destroy('PAGE_CLOSED');
      engine.current = null;
    };
  }, [session, exit, onReceived, memoryUsed]);

  const localMember = members.find(({ id }) => id === session.peerId);
  const others = members.filter(({ id }) => id !== session.peerId);
  const deviceList = localMember ? [localMember, ...others] : others;
  const selected = others.find(({ id }) => id === recipient) ?? (others.length === 1 ? others[0] : undefined);
  const visibleShares = shares.filter(({ expiresAt: until }) => until > now);
  const ownShare = visibleShares.find(({ ownerId }) => ownerId === session.peerId);
  const incomingRequests = requests.filter(({ shareId, from }) => shareId === ownShare?.id && others.some(({ id }) => id === from));
  const receiving = jobs.find(({ direction, phase }) => direction === 'receive' &&
    (phase === 'incoming' || phase === 'preparing' || phase === 'transferring' || phase === 'verifying'));
  const history = [...texts, ...jobs.filter(({ id }) => id !== receiving?.id)].sort((a, b) => b.createdAt - a.createdAt);
  const ready = status === 'online';
  const hasText = draft.trim().length > 0;
  const draftTooLong = textTooLong(draft);
  const sendFeedback: SendResult | undefined = draftTooLong ? { code: 'TEXT_TOO_LONG' } : sendResult;
  const sendError = draftTooLong || (sendResult && ('code' in sendResult || sendResult.key === 'attachmentLimit'));
  const canAttach = ready && !sending;
  const canSend = canAttach && selected && !draftTooLong && (hasText || files.length > 0);

  function report(action: () => void) {
    try { setNotice(undefined); action(); } catch (error) { setNotice({ code: codeOf(error) }); }
  }

  function addFiles(list: FileList | null) {
    if (!list?.length || !canAttach || sendInFlight.current) return;
    if (files.length + list.length > MAX_BATCH_FILES) {
      setSendResult({ key: 'attachmentLimit', values: { count: MAX_BATCH_FILES } });
      return;
    }
    setFiles([...files, ...list]);
    setSendResult(undefined);
  }

  function fileChanged(event: ChangeEvent<HTMLInputElement>) {
    addFiles(event.currentTarget.files);
    event.currentTarget.value = '';
  }

  function dragOver(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canAttach ? 'copy' : 'none';
    if (canAttach) setDragging(true);
  }

  function drop(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = engine.current;
    if (!current || !selected || !canSend || sendInFlight.current) return;
    sendInFlight.current = true;
    setSending(true);
    setSendResult(undefined);
    let attachmentsQueued = false;
    try {
      if (files.length) {
        current.transfers.enqueue(selected, files);
        attachmentsQueued = true;
        setFiles([]);
      }
      if (hasText) await current.texts.send(selected, draft);
      if (engine.current !== current) return;
      setDraft('');
      if (hasText) setSendResult({ key: 'textReceivedBy', values: { name: selected.name } });
    } catch (error) {
      if (engine.current === current) {
        setSendResult({ code: codeOf(error, 'CONNECTION_LOST'), attachmentsQueued });
      }
    } finally {
      sendInFlight.current = false;
      if (engine.current === current) setSending(false);
    }
  }

  function publish() {
    report(() => {
      const id = randomId();
      const size = files.reduce((sum, file) => sum + file.size, 0);
      if (!Number.isSafeInteger(size)) throw new Error('FILE_TOO_LARGE');
      if (audience && !others.some((peer) => peer.id === audience)) throw new Error('PEER_OFFLINE');
      engine.current!.client.send({ type: 'share.publish', shareId: id, count: files.length, size: String(size), audience: audience || null });
      published.current = { id, files, expiresAt: Date.now() + INVITE_TTL };
      setRequests([]);
      setFiles([]);
      setSendResult(undefined);
      setConfirmation(undefined);
    });
  }

  async function management(action: 'leave' | 'end' | 'rotate' | 'kick', peer?: Member) {
    const base = '/' + session.roomId;
    setConfirmation(undefined);
    setBusy(true);
    setNotice(undefined);
    try {
      if (action === 'rotate') {
        const next = await api<Invite>(base + '/invites/rotate', { method: 'POST', token: session.adminToken });
        saveSession({ ...session, invite: next });
        setInvite(next);
      } else if (action === 'kick' && peer) {
        await api(base + '/members/' + peer.id, { method: 'DELETE', token: session.adminToken });
      } else {
        const leave = action === 'leave';
        ownExit.current = true;
        await api(leave ? base + '/members/self' : base, { method: 'DELETE',
          token: leave ? session.token : session.adminToken });
        if (engine.current) {
          engine.current.transfers.destroy(leave ? 'MEMBER_REVOKED' : 'ROOM_CLOSED');
          exit();
        }
      }
    } catch (error) {
      ownExit.current = false;
      if (codeOf(error) === 'ROOM_CLOSED') exit('ROOM_CLOSED');
      else setNotice({ code: codeOf(error) });
    } finally {
      setBusy(false);
    }
  }

  function renderTransfer(item: TransferView) {
    const staged = item.direction === 'receive' && item.phase === 'stored' ? getStored(item.id) : undefined;
    return <TransferRow key={item.id} item={item} storage={storage} direct={hasSavePicker()}
      online={others.some(({ id }) => id === item.peer)}
      onAccept={(choice) => void engine.current?.transfers.accept(item.id, choice)}
      onReject={() => engine.current?.transfers.reject(item.id)}
      onCancel={() => engine.current?.transfers.cancel(item.id)}
      onRetry={(restart) => report(() => engine.current?.transfers.retry(item.id, restart))}
      finderItem={finderAvailable ? staged : undefined}
      onOpenFile={() => openFile({
        id: item.id, file: item.file, senderName: item.peerName, receivedAt: item.receivedAt, saved: item.phase === 'saved',
      }, item.phase === 'stored')} />;
  }

  return <>
    <SiteHeader archiveCount={archiveCount} openShelf={openShelf} changeLanguage={changeLanguage}
      leave={{ disabled: busy, confirm: () => setConfirmation({ type: 'leave' }) }} />
    <main className="shell workspace">
      <section className="room-header">
        <div className="room-header-meta">
          <div className={'connection-status ' + (ready ? 'connection-online' : '')}>
            <span /> {t(ready ? 'roomOnline' : status === 'connecting' ? 'joiningRoom' : 'reconnecting')}
          </div>
          <p className="room-expiry muted">{t('roomExpiry', { time: clock(expiresAt) })}{lanHttp && <> · {t('lanHttp')}</>}</p>
        </div>
        <h1 className="marked-heading">{t('roomTitle')}</h1>
      </section>
      {notice && <div className="notice page-notice" role="status">{'code' in notice ? feedback(notice.code) : t(notice.key)}
        <button className="icon-button" aria-label={t('closeNotice')} onClick={() => setNotice(undefined)}><X size={16} /></button></div>}
      <div className="visually-hidden" aria-live="polite">
        {receiving?.phase === 'incoming' && t('incomingFile', { name: receiving.file.name })}
      </div>
      {receiving && <section className="incoming-section" aria-labelledby="incoming-title">
        <div className="section-heading"><File size={20} />
          <h2 id="incoming-title">{t(receiving.phase === 'incoming' ? 'receiveRequest' : 'receiving')}</h2>
        </div>
        <ul>{renderTransfer(receiving)}</ul>
      </section>}
      {invite && <InvitationPanel invite={invite} room={session.roomId} now={now} busy={busy} rotate={() => void management('rotate')} />}
      <div className="room-grid">
        <section className="devices-section" aria-labelledby="device-title">
          <div className="section-heading"><Users size={20} /><h2 id="device-title">{t('onlineDevices')}</h2>
            <bdi className="section-count" dir="ltr">{number(members.length)} / {number(ROOM_CAPACITY)}</bdi>
          </div>
          <ul className="devices">
            {deviceList.map((member) => {
              const self = member.id === session.peerId;
              return <li key={member.id} className="device-row">
                {self ? <>
                  <div className="device self"><span className="device-icon"><DeviceIcon kind={member.kind} /></span>
                    <bdi className="device-name" title={member.name}>{member.name}</bdi><span className="device-note">{t('thisDevice')}</span></div>
                  <button type="button" className="icon-button rename-device" aria-label={t('renameDevice')} title={t('renameDevice')}
                    disabled={!ready || busy} onClick={() => setRenameOpen(true)}><Pencil size={17} /></button>
                </> :
                  <button className={'device ' + (selected?.id === member.id ? 'selected' : '')}
                    aria-pressed={selected?.id === member.id} aria-label={t('selectDevice', { name: member.name })} onClick={() => setRecipient(member.id)}>
                    <span className="device-icon"><DeviceIcon kind={member.kind} /></span>
                    <bdi className="device-name">{member.name}</bdi>{member.host && <span className="device-note">{t('host')}</span>}
                    {selected?.id === member.id ? <Check size={17} className="device-arrow" /> : <ChevronRight size={17} className="device-arrow" />}
                  </button>}
                {!self && session.adminToken && <button className="icon-button kick" aria-label={t('removeDeviceName', { name: member.name })} title={t('removeDevice')}
                  onClick={() => setConfirmation({ type: 'kick', peer: member })}><X size={17} /></button>}
              </li>;
            })}
          </ul>
          {!others.length && <p className="empty-inline">{t(ready ? 'waitingForDevice' : 'syncingDevices')}</p>}
        </section>

        <section aria-labelledby="send-title" className="send-section">
          <div className="section-heading"><MessageSquare size={20} /><h2 id="send-title">{t('send')}</h2>
            {selected && <span className="section-count send-target" title={selected.name}>{t('sendTarget', { name: selected.name })}</span>}
          </div>
          <form className={'send-composer' + (dragging ? ' dragging' : '')} aria-busy={sending}
            onSubmit={(event) => void send(event)} onDragOver={dragOver} onDrop={drop}
            onDragLeave={(event) => {
              if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
            }}>
            {files.length > 0 && <ul className="composer-attachments" aria-label={t('attachments')}>
              {files.map((file, index) => <li key={index}>
                <File size={18} aria-hidden="true" />
                <span className="composer-file">
                  <strong title={file.name}><bdi>{file.name}</bdi></strong>
                  <small><bdi>{sizeText(file.size)}</bdi></small>
                </span>
                <button type="button" className="icon-button remove-attachment" aria-label={t('removeAttachment', { name: file.name })} disabled={sending}
                  onClick={() => {
                    setFiles((list) => list.filter((_, position) => position !== index));
                    setSendResult(undefined);
                  }}><X size={16} /></button>
              </li>)}
            </ul>}
            <textarea rows={2} dir="auto" aria-label={t('textToSend')} placeholder={t('textPlaceholder')}
              value={draft} readOnly={sending} aria-invalid={draftTooLong} enterKeyHint="send"
              aria-describedby={sendFeedback ? 'send-feedback' : undefined}
              onChange={(event) => { setDraft(event.currentTarget.value); setSendResult(undefined); }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                event.preventDefault();
                if (canSend && !event.repeat) event.currentTarget.form?.requestSubmit();
              }} />
            <div className="composer-toolbar">
              <input ref={fileInput} type="file" multiple hidden disabled={!canAttach} onChange={fileChanged} aria-label={t('filesToSend')} />
              <button className="button secondary attach-files" type="button" disabled={!canAttach} onClick={() => fileInput.current?.click()}>
                <Paperclip size={17} /> {t('attachFiles')}
              </button>
              {(dragging || files.length === 0) && <span className="composer-hint">
                {t(dragging ? 'dropAttach' : 'dragFiles')}
              </span>}
              {files.length > 0 && <button className="button quiet publish-files" type="button" disabled={!canAttach} onClick={() => {
                setAudience('');
                setConfirmation({ type: 'publish' });
              }}><Link2 size={16} /> {t('publishFiles')}</button>}
              <button className="button primary send-content" type="submit" disabled={!canSend}
                aria-label={selected ? t('sendTo', { name: selected.name }) : t('send')}>
                <ArrowUp size={18} /> {t(sending ? 'sending' : 'send')}
              </button>
            </div>
          </form>
          {sendFeedback && <p id="send-feedback" role="status"
            className={'composer-feedback ' + (sendError ? 'notice' : 'muted')}>
            {'code' in sendFeedback ? sendFeedback.attachmentsQueued ?
              t('attachmentsQueued', { error: feedback(sendFeedback.code) }) : feedback(sendFeedback.code) :
              t(sendFeedback.key, sendFeedback.values)}
          </p>}
          {!selected && ready && others.length > 1 && <p className="composer-feedback muted">{t('chooseRecipient')}</p>}
        </section>
      </div>

      {(visibleShares.length > 0 || incomingRequests.length > 0) && <section className="shares-section" aria-labelledby="shares-title">
        <div className="section-heading"><Link2 size={20} /><h2 id="shares-title">{t('sharedFiles')}</h2></div>
        <ul className="share-list">
          {visibleShares.map((share) => {
            const owner = members.find(({ id }) => id === share.ownerId);
            if (!owner) return null;
            const mine = owner.id === session.peerId;
            return <li key={share.id}>
              <div><strong>{mine ? t('publishedByYou') : t('publishedBy', { name: owner.name })}</strong>
                <p>{t('shareInfo', { count: share.count, size: sizeText(Number(share.size)), time: clock(share.expiresAt) })}</p></div>
              <button className="button secondary" disabled={!ready} onClick={() => report(() => {
                engine.current!.client.send(mine ? { type: 'share.remove' } : { type: 'share.request', shareId: share.id });
                if (mine) { published.current = null; setRequests([]); }
                else setNotice({ key: 'requestSent' });
              })}>{t(mine ? 'unpublish' : 'requestFiles')}</button>
            </li>;
          })}
          {incomingRequests.map((request) => {
            const peer = others.find(({ id }) => id === request.from)!;
            return <li key={request.from}>
              <strong>{t('requestedBy', { name: peer.name })}</strong>
              <div className="actions">
                <button className="button secondary" disabled={!ready} onClick={() => report(() => {
                  if (published.current?.id !== request.shareId) throw new Error('PEER_OFFLINE');
                  engine.current!.transfers.enqueue(peer, published.current.files);
                  setRequests((entries) => entries.filter((entry) => entry !== request));
                })}>{t('approveSend')}</button>
                <button className="button quiet" onClick={() =>
                  setRequests((entries) => entries.filter((entry) => entry !== request))}>{t('ignore')}</button>
              </div>
            </li>;
          })}
        </ul>
      </section>}

      <section className="history-section" aria-labelledby="history-title">
        <div className="section-heading"><ArrowLeftRight size={20} /><h2 id="history-title">{t('transferHistory')}</h2></div>
        <div className="history-body">
          {!history.length ? <p className="empty-inline">{t('emptyHistory')}</p> :
            <ul className="transfer-list">{history.map((item) => 'text' in item ?
              <TextTransferRow key={['text', item.direction, item.peer, item.id].join(':')} item={item} /> : renderTransfer(item))}</ul>}
          {invite && <button className="button quiet end-room" disabled={busy} onClick={() => setConfirmation({ type: 'end' })}>
            {t('endRoom')}
          </button>}
        </div>
      </section>
      <footer className="room-footer"><Shield size={16} /> {t('stayInForeground')}</footer>
      {renameOpen && localMember && <RenameDeviceDialog name={localMember.name}
        save={(name) => renameMember(session, name)} close={() => setRenameOpen(false)} />}
      {confirmation && <Modal
        title={t(confirmation.type === 'publish' ? 'publishTitle' : confirmation.type === 'kick' ? 'removeDevice' :
          confirmation.type === 'end' ? 'endRoom' : 'leaveRoom')}
        close={() => setConfirmation(undefined)}>
        {confirmation.type === 'publish' ? <>
          <p className="muted">{t('publishHint')}</p>
          <label htmlFor="share-audience">{t('shareAudience')}</label>
          <select id="share-audience" value={audience} onChange={(event) => setAudience(event.currentTarget.value)}>
            <option value="">{t('allRoomDevices')}</option>
            {others.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
          <div className="actions modal-actions"><button className="button primary" onClick={publish}>{t('publish')}</button></div>
        </> : <>
          <p>{confirmation.type === 'kick' ? t('removeDeviceHint', { name: confirmation.peer.name }) :
            t(confirmation.type === 'end' ? 'endRoomHint' : 'leaveRoomHint')}</p>
          <div className="actions modal-actions">
            <button className="button secondary" onClick={() => setConfirmation(undefined)}>{t('back')}</button>
            <button className="button danger" onClick={() => void management(confirmation.type,
              confirmation.type === 'kick' ? confirmation.peer : undefined)}>{t('confirm')}</button>
          </div>
        </>}
      </Modal>}
    </main>
    <SiteFooter />
  </>;
}
