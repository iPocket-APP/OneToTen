import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, ChevronRight, Copy, Download, File, FolderOpen, Laptop, Share2, Smartphone, Tablet, Trash2, X } from 'lucide-react';
import { MAX_DEVICE_NAME_LENGTH, cleanLabel } from '../shared/room.ts';
import type { DeviceKind } from '../shared/room.ts';
import { copyText } from './clipboard.ts';
import { useI18n } from './i18n.tsx';
import type { MessageKey } from './i18n.tsx';
import { codeOf } from './labels.ts';
import { revealReceivedFile } from './local-finder.ts';
import { INDEXED_DB_LIMIT, MEMORY_LIMIT, OPFS_LIMIT, canResume } from './protocol.ts';
import type { SaveChoice } from './protocol.ts';
import { openStored } from './storage-model.ts';
import type { StorageProbe } from './storage-model.ts';
import type { TextTransfer } from './text-transfers.ts';
import type { FileReceipt, ShelfItem, TransferView } from './transfers.ts';

export function DeviceIcon({ kind, size = 22 }: { kind: DeviceKind; size?: number }) {
  const Icon = kind === 'tablet' ? Tablet : kind === 'desktop' || kind === 'other' ? Laptop : Smartphone;
  return <Icon size={size} aria-hidden="true" />;
}

export function Modal({ title, close, children, dismissible = true }: {
  title: string; close: () => void; children: ReactNode; dismissible?: boolean;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="modal" ref={dialog} aria-label={title} onCancel={(event) => {
    event.preventDefault();
    if (dismissible) close();
  }}>
    <div className="modal-heading">
      <h2>{title}</h2>
      <button type="button" className="icon-button" aria-label={t('close')} disabled={!dismissible} onClick={close}><X size={20} /></button>
    </div>
    {children}
  </dialog>;
}

export function RenameDeviceDialog({ name, save, close }: {
  name: string; save: (name: string) => Promise<void>; close: () => void;
}) {
  const { t, feedback } = useI18n();
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const nextName = cleanLabel(draft).trim();
  const canSave = !saving && nextName.length > 0 && nextName.length <= MAX_DEVICE_NAME_LENGTH && nextName !== name;

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setNotice('');
    try {
      await save(nextName);
      close();
    } catch (error) {
      setNotice(codeOf(error));
      setSaving(false);
    }
  }

  return <Modal title={t('renameDevice')} close={close} dismissible={!saving}>
    <form onSubmit={(event) => void submit(event)}>
      <label htmlFor="room-device-name">{t('deviceName')}</label>
      <input id="room-device-name" ref={field} value={draft} dir="auto" maxLength={MAX_DEVICE_NAME_LENGTH}
        autoComplete="off" required readOnly={saving} aria-describedby={notice ? 'rename-notice' : undefined}
        onChange={(event) => { setDraft(event.currentTarget.value); setNotice(''); }} />
      {notice && <p id="rename-notice" className="notice rename-notice" role="alert">{feedback(notice)}</p>}
      <div className="actions modal-actions">
        <button type="button" className="button secondary" disabled={saving} onClick={close}>{t('cancel')}</button>
        <button type="submit" className="button primary" disabled={!canSave}>{t(saving ? 'saving' : 'save')}</button>
      </div>
    </form>
  </Modal>;
}

function FinderFileAction({ item }: { item: ShelfItem }) {
  const { t, feedback } = useI18n();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<{ name: string; revealed: boolean } | { code: string }>();

  async function show() {
    setSaving(true);
    setStatus(undefined);
    try {
      const result = await revealReceivedFile(item);
      setSaved(true);
      setStatus(result);
    } catch (error) {
      setStatus({ code: codeOf(error, 'SAVE_UNAVAILABLE') });
    } finally {
      setSaving(false);
    }
  }

  return <>
    <button className="button secondary" type="button" title={t('finderSaveLocation')}
      disabled={saving} onClick={() => void show()}>
      <FolderOpen size={16} /> {t(saving ? 'finderSaving' : saved ? 'showInFinder' : 'saveAndShowInFinder')}
    </button>
    {status && <span className="muted" role="status">{'code' in status ? feedback(status.code) :
      status.revealed ? t('finderShown', { name: status.name }) : t('finderSaved')}</span>}
  </>;
}

export function TransferRow({ item, storage, direct, online, onAccept, onReject, onCancel, onRetry, onOpenFile, finderItem }: {
  item: TransferView; storage: StorageProbe; direct: boolean; online: boolean;
  onAccept: (choice?: SaveChoice) => void; onReject: () => void; onCancel: () => void;
  onRetry: (restart: boolean) => void; onOpenFile: () => void; finderItem?: ShelfItem;
}) {
  const { t, feedback, messages, sizeText, percent } = useI18n();
  const size = Number(item.file.size_bytes);
  const total = Math.max(1, size);
  const finished = item.phase === 'stored' || item.phase === 'saved';
  const receiving = item.direction === 'receive';
  const preparing = receiving && item.phase === 'preparing';
  const receivingBytes = receiving && (item.phase === 'transferring' || item.phase === 'verifying');
  const progress = preparing || item.phase === 'transferring' || item.phase === 'verifying' || finished ||
    (item.phase === 'paused' && item.checkpoint > 0);
  const written = item.phase === 'paused' ? item.checkpoint : item.written;
  const progressValue = finished || (receiving && item.phase === 'verifying') ? total : written;
  const cancellable = ['queued', 'connecting', 'awaiting', 'preparing', 'transferring', 'paused'].includes(item.phase);
  const stagingChoice = storage.staging === 'indexed-db' ? 'indexed-db' : 'opfs';
  const showStaging = Boolean(storage.staging) && size <= (stagingChoice === 'indexed-db' ? INDEXED_DB_LIMIT : OPFS_LIMIT);
  const showMemory = size <= MEMORY_LIMIT;
  const DirectionIcon = receiving ? ArrowDownLeft : ArrowUpRight;
  let stateLabel = messages.phases[item.phase];
  if (receiving && item.phase === 'incoming' && item.resume) stateLabel = t('resumeRequest');
  if (receiving && item.phase === 'transferring') stateLabel = t('receivingFiles');
  if (receiving && item.phase === 'verifying') stateLabel = t('verifyingFile');
  if (finished && !receiving) stateLabel = t(item.phase === 'saved' ? 'peerSaved' : 'peerStaged');

  return <li className="transfer" data-transfer={item.id}
    data-direction={item.direction} data-phase={item.phase}>
    <div className="transfer-top">
      <span className="file-icon"><DirectionIcon size={20} /></span>
      <div className="transfer-heading">
        <strong title={item.file.name}><bdi>{item.file.name}</bdi></strong>
        <p>{t(receiving ? 'fromDevice' : 'sendTo', { name: item.peerName })} <span aria-hidden="true">·</span> <bdi>{sizeText(size)}</bdi></p>
      </div>
      <span className={'transfer-state state-' + item.phase}>
        {finished && <Check size={16} aria-hidden="true" />}
        {stateLabel}</span>
    </div>
    {item.code && <p className="transfer-message">{feedback(item.code)}</p>}
    {item.phase === 'incoming' && <>
      <p className="transfer-message">{t(item.path === 'direct' ? 'directConnection' : 'unknownPath')}{!item.resume && showStaging &&
        <> · {t(canResume(storage.staging ?? undefined) ? 'stagingCanResume' : 'stagedDownload')}</>}</p>
      {!item.resume && !direct && !showStaging && !showMemory &&
        <p className="transfer-message">{t('unsupportedSize')}</p>}
      <div className="actions transfer-actions">
        {item.resume ? <button className="button primary" onClick={() => onAccept()}>{t('confirmResume')}</button> : <>
          {direct && <button className="button primary" onClick={() => onAccept('direct')}>{t('chooseSaveLocation')}</button>}
          {showStaging && <button className={'button ' + (direct ? 'secondary' : 'primary')}
            onClick={() => onAccept(stagingChoice)}>{t('receiveStaged')}</button>}
          {!showStaging && showMemory && <button className={'button ' + (direct ? 'secondary' : 'primary')}
            onClick={() => onAccept('memory')}>{t('receiveInMemory')}</button>}
          {showStaging && showMemory && (item.code === 'STORAGE_UNAVAILABLE' || item.code === 'QUOTA_EXCEEDED') &&
            <button className="button secondary" onClick={() => onAccept('memory')}>{t('receiveInMemory')}</button>}
        </>}
        <button className="button quiet" onClick={onReject}>{t('reject')}</button>
      </div>
    </>}
    {progress && <div className="transfer-progress">
      <progress aria-label={t(receiving ? 'localProgress' : 'remoteProgress')} max={total} value={preparing ? undefined : progressValue} />
      {!preparing && <div className="transfer-progress-summary">
        <p><bdi dir="ltr">{sizeText(written)} / {sizeText(size)}</bdi>
          {item.speed ? <> · <bdi>{t('perSecond', { size: sizeText(item.speed) })}</bdi></> : null}
          {item.mode === 'memory' && finished && <> · {t('pageMemory')}</>}</p>
        {receivingBytes && <strong aria-hidden="true">{percent(Math.floor(progressValue / total * 100) / 100)}</strong>}
      </div>}
    </div>}
    {item.phase === 'paused' && receiving &&
      <p className="transfer-message">{t('resumeCheckpoint', { size: sizeText(item.checkpoint) })}</p>}
    {(cancellable || item.canRetry || (receiving && finished)) && <div className="actions transfer-actions">
      {item.canRetry && item.resume && <button className="button secondary" disabled={!online} onClick={() => onRetry(false)}>{t('resume')}</button>}
      {item.canRetry && <button className="button quiet" disabled={!online} onClick={() => onRetry(true)}>{t('resend')}</button>}
      {cancellable && <button className="button quiet" onClick={onCancel}>{t('cancelTransfer')}</button>}
      {receiving && item.phase === 'stored' && finderItem && <FinderFileAction item={finderItem} />}
      {receiving && finished && <button className="button secondary" onClick={onOpenFile}>
        {item.phase === 'stored' ? <><Download size={16} /> {t('exportFile')}</> : <><File size={16} /> {t('viewDetails')}</>}
      </button>}
    </div>}
  </li>;
}

export function TextTransferRow({ item }: { item: TextTransfer }) {
  const { t } = useI18n();
  const content = useRef<HTMLParagraphElement>(null);
  const [status, setStatus] = useState<'copied' | 'copyTextManually'>();
  const receiving = item.direction === 'receive';
  const DirectionIcon = receiving ? ArrowDownLeft : ArrowUpRight;

  async function copy() {
    if (await copyText(item.text)) {
      setStatus('copied');
    } else {
      const selection = window.getSelection();
      if (content.current && selection) selection.selectAllChildren(content.current);
      setStatus('copyTextManually');
    }
  }

  return <li className="transfer" data-text-direction={item.direction}>
    <div className="transfer-top">
      <span className="file-icon"><DirectionIcon size={20} /></span>
      <div className="transfer-heading">
        <strong>{t('text')}</strong>
        <p>{t(receiving ? 'fromDevice' : 'sendTo', { name: item.peerName })}</p>
      </div>
      <span className="transfer-state state-stored">{t(receiving ? 'textReceived' : 'peerReceived')}</span>
    </div>
    <p ref={content} className="text-transfer-content" dir="auto" tabIndex={0}>{item.text}</p>
    <div className="actions transfer-actions">
      <button type="button" className="button secondary" onClick={() => void copy()}><Copy size={16} /> {t('copyText')}</button>
      <span className="muted" role="status">{status && t(status)}</span>
    </div>
  </li>;
}

export function FileReceiptToast({ receipt, open, dismiss }: {
  receipt: FileReceipt; open: (receipt: FileReceipt) => void; dismiss: (id: string) => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = window.setTimeout(() => dismiss(receipt.id), 12_000);
    return () => window.clearTimeout(timer);
  }, [dismiss, focused, hovered, receipt.id]);

  return <li className="receipt-toast" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={(event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    }}>
    <button type="button" className="receipt-open" aria-label={t('viewReceipt', { name: receipt.file.name })} onClick={() => open(receipt)}>
      <span className="receipt-check"><Check size={20} aria-hidden="true" /></span>
      <span className="receipt-copy">
        <strong>{t('fileReceived')}</strong>
        <bdi className="receipt-name" title={receipt.file.name}>{receipt.file.name}</bdi>
        <span className="receipt-link">{t('viewFileDetails')} <ChevronRight size={14} aria-hidden="true" /></span>
      </span>
    </button>
    <button type="button" className="icon-button receipt-dismiss" aria-label={t('closeReceipt', { name: receipt.file.name })}
      onClick={() => dismiss(receipt.id)}><X size={16} /></button>
  </li>;
}

function StoredFileActions({ item, prepare, remove, finderAvailable }: {
  item: ShelfItem; prepare: boolean; remove: (item: ShelfItem) => Promise<void>; finderAvailable: boolean;
}) {
  const { t, feedback } = useI18n();
  const [file, setFile] = useState<File>();
  const [url, setUrl] = useState<string>();
  const [notice, setNotice] = useState<{ key: MessageKey } | { code: string }>();
  const [requested, setRequested] = useState(prepare || item.entry?.mode !== 'indexed-db');
  const downloaded = useRef(false);
  useEffect(() => {
    if (!requested) return;
    let disposed = false;
    let objectUrl: string | undefined;
    const source = item.memoryFile ? Promise.resolve(item.memoryFile) : item.entry ? openStored(item.entry) : Promise.reject();
    source.then((raw) => {
      if (disposed) return;
      const output = raw.name === item.file.name && raw.type === 'application/octet-stream' ?
        raw : new window.File([raw], item.file.name, { type: 'application/octet-stream' });
      objectUrl = URL.createObjectURL(output);
      setFile(item.file.mime && item.file.mime !== output.type ?
        new window.File([raw], item.file.name, { type: item.file.mime }) : output);
      setUrl(objectUrl);
    }).catch(() => { if (!disposed) setNotice({ code: 'EXPORT_UNAVAILABLE' }); });
    return () => {
      disposed = true;
      if (objectUrl) {
        const release = () => URL.revokeObjectURL(objectUrl!);
        if (downloaded.current) window.setTimeout(release, 30_000);
        else release();
      }
    };
  }, [item, requested]);
  const shareable = Boolean(file && navigator.canShare?.({ files: [file] }));
  return <>
    <div className="actions transfer-actions">
      {finderAvailable && <FinderFileAction item={item} />}
      {url && <a className="button secondary" href={url} download={item.file.name}
        onClick={() => { downloaded.current = true; setNotice({ key: 'startingDownload' }); }}><Download size={16} /> {t('download')}</a>}
      {!requested && <button className="button secondary" onClick={() => setRequested(true)}>{t('prepareDownload')}</button>}
      {requested && !url && !notice && <span className="muted" role="status">{t('preparingDownload')}</span>}
      {file && shareable && <button className="button secondary" onClick={() => {
        void navigator.share({ files: [file] }).then(() => setNotice({ key: 'handedToShare' }))
          .catch((error: DOMException) => { if (error.name !== 'AbortError') setNotice({ code: 'EXPORT_UNAVAILABLE' }); });
      }}><Share2 size={16} /> {t('systemShare')}</button>}
      <button className="button quiet" onClick={() => {
        if (window.confirm(t('removeStagedConfirm'))) void remove(item).catch(() => setNotice({ code: 'STORAGE_UNAVAILABLE' }));
      }}><Trash2 size={16} /> {t('remove')}</button>
    </div>
    {notice && <p className="transfer-message" role="status">{'code' in notice ? feedback(notice.code) : t(notice.key)}</p>}
  </>;
}

function ExportRow({ item, remove, finderAvailable }: {
  item: ShelfItem; remove: (item: ShelfItem) => Promise<void>; finderAvailable: boolean;
}) {
  const { t, sizeText } = useI18n();
  return <li className="export-row">
    <div className="transfer-top">
      <span className="file-icon"><File size={20} /></span>
      <div className="transfer-heading">
        <strong><bdi>{item.file.name}</bdi></strong>
        <p><bdi>{sizeText(Number(item.file.size_bytes))}</bdi> · {t(item.entry ? 'browserStorage' : 'pageMemory')}</p>
      </div>
    </div>
    <StoredFileActions item={item} prepare={false} remove={remove} finderAvailable={finderAvailable} />
  </li>;
}

export function Shelf({ items, close, remove, finderAvailable }: {
  items: ShelfItem[]; close: () => void; remove: (item: ShelfItem) => Promise<void>; finderAvailable: boolean;
}) {
  const { t } = useI18n();
  return <Modal title={t('receivedFiles')} close={close}>
    {items.length === 0 ? <p className="muted">{t('emptyReceivedFiles')}</p> :
      <ul className="export-list">{items.map((item) => <ExportRow key={item.id} item={item}
        remove={remove} finderAvailable={finderAvailable} />)}</ul>}
  </Modal>;
}

export function ReceivedFileDetails({ receipt, staged, prepare, close, remove, finderAvailable }: {
  receipt: FileReceipt; staged?: ShelfItem; prepare: boolean; close: () => void;
  remove: (item: ShelfItem) => Promise<void>; finderAvailable: boolean;
}) {
  const { t, messages, sizeText, dateTime } = useI18n();
  const completed = receipt.receivedAt === undefined ? undefined : new Date(receipt.receivedAt);
  const storageLabel = receipt.saved ? messages.phases.saved : !staged ? t('stagedFileRemoved') :
    staged.entry ? messages.phases.stored : t('verifiedInMemory');
  return <Modal title={t('fileDetails')} close={close}>
    <div className="file-detail-heading">
      <span className="file-icon"><File size={22} aria-hidden="true" /></span>
      <h3 dir="auto">{receipt.file.name}</h3>
    </div>
    <dl className="file-detail-meta">
      <div><dt>{t('fileSize')}</dt><dd><bdi>{sizeText(Number(receipt.file.size_bytes))}</bdi></dd></div>
      <div><dt>{t('sendingDevice')}</dt><dd><bdi>{receipt.senderName}</bdi></dd></div>
      {completed && <div><dt>{t('receivedAt')}</dt><dd><time dateTime={completed.toISOString()}>{dateTime(completed)}</time></dd></div>}
      <div><dt>{t('saveStatus')}</dt><dd>{storageLabel}</dd></div>
    </dl>
    {staged && <StoredFileActions item={staged} prepare={prepare} remove={remove} finderAvailable={finderAvailable} />}
  </Modal>;
}

