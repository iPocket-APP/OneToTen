import { MAX_BATCH_FILES, bytes, randomId } from '../shared/room.ts';
import type { Member, Session } from '../shared/room.ts';
import { codeOf } from './labels.ts';
import { CHECKPOINT, CREDIT_WINDOW, HEADER_BYTES, IO_BLOCK, MEMORY_LIMIT, SEND_HIGH_WATER,
  canResume, decodeFrame, encodeFrame, fileInfo, sameFileInfo } from './protocol.ts';
import type { FileInfo, FileSource, SaveChoice, SaveMode, TransferControl } from './protocol.ts';
import type { ConnectionPath, Pair } from './pairs.ts';
import type { ReceiveResult, ReceiveStart, ReceiveWrite, SavedRecord, TransferStorage } from './storage-model.ts';

type Timer = ReturnType<typeof setTimeout>;

export type Phase = 'queued' | 'connecting' | 'awaiting' | 'incoming' | 'preparing' | 'transferring' |
  'verifying' | 'paused' | 'stored' | 'saved' | 'rejected' | 'failed' | 'cancelled';

export interface TransferView {
  id: string;
  createdAt: number;
  direction: 'send' | 'receive';
  peer: string;
  peerName: string;
  file: FileInfo;
  phase: Phase;
  receivedAt?: number;
  localPath?: string;
  sha256?: string;
  path: ConnectionPath;
  written: number;
  checkpoint: number;
  speed?: number;
  mode?: SaveMode;
  code?: string;
  resume?: boolean;
  canRetry?: boolean;
}

export interface ShelfItem {
  id: string;
  file: FileInfo;
  senderName: string;
  entry?: SavedRecord;
  memoryFile?: File;
}

export type FileReceipt = Pick<ShelfItem, 'id' | 'file' | 'senderName'> & { saved: boolean; receivedAt?: number };

type Offer = Extract<TransferControl, { type: 'file.offer' | 'file.resume' }>;
type Acceptance = Extract<TransferControl, { type: 'file.accept' }>;
type Completion = { type: 'file.finish' | 'file.commit'; transfer_id: string; size_bytes: string; digest: string; saved?: boolean };
type Issue = 'file.reject' | 'file.cancel' | 'file.error';

interface ReceiveBuffer {
  bytes: Uint8Array<ArrayBuffer>;
  used: number;
  blocks: ArrayBuffer[];
  draining: boolean;
  last?: ReturnType<typeof decodeFrame>;
}

interface Job<Source extends FileSource> {
  view: TransferView;
  source?: Source;
  pair?: Pair;
  pipeline?: ReturnType<TransferStorage<Source>['pipeline']>;
  input?: ReceiveBuffer;
  offer?: Offer;
  finish?: Completion;
  digest?: string;
  receiptSaved?: boolean;
  sent: number;
  received: number;
  credit: number;
  timer?: Timer;
  wake?: () => void;
  stopping?: boolean;
  speedAt?: number;
  speedBytes?: number;
}

interface Options<Source extends FileSource> {
  connect: (peer: string) => Promise<Pair>;
  peer: (peer: string) => Member | undefined;
  onChange: (views: TransferView[]) => void;
  onReceived: (receipt: FileReceipt, staged?: ShelfItem) => void;
  memoryUsed: () => number;
  storage: TransferStorage<Source>;
  historyLimit?: number;
}

const activePhases = new Set<Phase>(['connecting', 'awaiting', 'incoming', 'preparing', 'transferring', 'verifying']);
const receiptPhases = new Set<Phase>(['stored', 'saved']);
const resumableErrors = new Set(['CONNECTION_LOST', 'TIMEOUT', 'SIGNAL_DISCONNECTED', 'PEER_OFFLINE', 'DIRECT_CONNECTION_FAILED']);
const RESUME_TIMEOUT = 10 * 60_000;

export class Transfers<Source extends FileSource = File> {
  private readonly jobs = new Map<string, Job<Source>>();
  private readonly restore: Promise<void>;
  private active?: Job<Source>;
  private closed = false;
  private renderTimer?: Timer;

  constructor(private readonly session: Session, private readonly options: Options<Source>) {
    this.restore = options.storage.records().then((entries) => {
      if (this.closed) return;
      for (const entry of entries.sort((a, b) => a.updatedAt - b.updatedAt)) {
        if (entry.roomId !== session.roomId || entry.receiver !== session.peerId || this.jobs.has(entry.id)) continue;
        if (!entry.digest && (!canResume(entry.mode) || (entry.expiresAt ?? Infinity) <= Date.now())) continue;
        this.jobs.set(entry.id, {
          view: {
            id: entry.id, createdAt: entry.updatedAt, direction: 'receive', phase: entry.digest ? 'stored' : 'paused',
            receivedAt: entry.digest ? entry.updatedAt : undefined,
            path: 'unknown', peer: entry.sender,
            peerName: entry.senderName, file: entry.file, written: entry.checkpoint,
            checkpoint: entry.checkpoint, mode: entry.mode,
          },
          digest: entry.digest ?? undefined, sent: 0, received: 0, credit: 0,
        });
      }
      this.emit();
    }).catch(() => undefined);
  }

  private emit(throttle = false): void {
    if (this.closed) return;
    if (throttle) {
      this.renderTimer ??= setTimeout(() => this.emit(), 90);
      return;
    }
    clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.options.onChange(this.views());
  }

  views(): TransferView[] {
    return [...this.jobs.values()].reverse().map(({ view }) => ({ ...view }));
  }

  view(id: string): TransferView | undefined {
    const job = this.jobs.get(id);
    if (job) return { ...job.view };
  }

  private phase(job: Job<Source>, phase: Phase, code?: string): void {
    job.view.phase = phase;
    job.view.code = code;
    this.emit();
  }

  private isActive(job: Job<Source>): boolean {
    return this.active === job && !job.stopping && !this.closed;
  }

  private arm(job: Job<Source>, milliseconds = 90_000): void {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      if (!this.isActive(job)) return;
      if (job.view.direction === 'receive' && job.view.phase === 'verifying') return;
      void this.fail(job, 'TIMEOUT');
    }, milliseconds);
  }

  enqueue(peer: Member, sources: Source[]): string[] {
    const queued = [...this.jobs.values()].filter(({ view }) => view.phase === 'queued').length;
    if (!sources.length || sources.length + queued > MAX_BATCH_FILES) throw new Error('QUEUE_FULL');
    const jobs = sources.map((source): Job<Source> => ({
      view: {
        id: randomId(), createdAt: Date.now(), direction: 'send', peer: peer.id, peerName: peer.name, phase: 'queued',
        file: fileInfo(source), written: 0, checkpoint: 0, path: 'unknown',
      },
      source, sent: 0, received: 0, credit: 0,
    }));
    for (const job of jobs) this.jobs.set(job.view.id, job);
    this.emit();
    this.next();
    return jobs.map(({ view }) => view.id);
  }

  private next(): void {
    if (this.active || this.closed) return;
    const job = [...this.jobs.values()].find(({ view }) => view.phase === 'queued');
    if (job) void this.offer(job);
  }

  private async offer(job: Job<Source>): Promise<void> {
    this.active = job;
    this.phase(job, 'connecting');
    this.arm(job);
    try {
      const pair = await this.options.connect(job.view.peer);
      if (!this.isActive(job)) return;
      job.pair = pair;
      job.view.path = pair.path;
      const { id, file, resume } = job.view;
      pair.send(resume ? { type: 'file.resume', transfer_id: id, file, full_digest: job.digest ?? null }
        : { type: 'file.offer', transfer_id: id, file, integrity: { algorithm: 'sha256', checkpoint_bytes: CHECKPOINT } });
      this.phase(job, 'awaiting');
      this.arm(job, resume ? RESUME_TIMEOUT : 120_000);
    } catch (error) {
      if (this.isActive(job)) await this.fail(job, codeOf(error, 'DIRECT_CONNECTION_FAILED'));
    }
  }

  control(pair: Pair, message: TransferControl): void {
    if (this.closed) return;
    const id = message.transfer_id;
    let job = this.jobs.get(id);
    if (message.type === 'file.offer' || message.type === 'file.resume') {
      if (message.type === 'file.offer' && job?.view.phase === 'incoming' && job.pair === pair) return;
      if (this.active) {
        this.sendIssue(pair, id, 'file.reject', 'PEER_BUSY');
        return;
      }
      if (job && (job.view.peer !== pair.peer.id || job.view.direction !== 'receive' ||
          !sameFileInfo(job.view.file, message.file) || message.type === 'file.offer' ||
          (job.view.phase !== 'paused' && !receiptPhases.has(job.view.phase)))) {
        this.sendIssue(pair, id, 'file.reject', 'CHECKPOINT_MISMATCH');
        return;
      }
      job ??= {
        view: { id, createdAt: Date.now(), direction: 'receive', peer: pair.peer.id, peerName: pair.peer.name, file: message.file,
          phase: 'incoming', path: pair.path, written: 0, checkpoint: 0 },
        sent: 0, received: 0, credit: 0,
      };
      job.view.resume = message.type === 'file.resume';
      job.view.path = pair.path;
      job.offer = message;
      job.pair = pair;
      job.finish = undefined;
      job.stopping = false;
      this.jobs.set(id, job);
      this.active = job;
      this.phase(job, 'incoming');
      this.arm(job, 120_000);
      return;
    }
    if (!job || job.pair !== pair || !this.isActive(job)) {
      if (job?.view.peer === pair.peer.id && job.view.direction === 'receive' && job.digest === ('digest' in message ? message.digest : undefined)
          && message.type === 'file.finish' && receiptPhases.has(job.view.phase) && message.size_bytes === job.view.file.size_bytes) {
        this.sendReceipt(pair, job, message.digest, Boolean(job.receiptSaved));
      }
      if (message.type === 'file.cancel' && job?.view.peer === pair.peer.id && job.view.direction === 'receive' &&
          job.view.phase === 'paused') void this.stop(job, 'cancelled', message.code);
      return;
    }
    try {
      switch (message.type) {
        case 'file.accept':
          if (job.view.direction === 'send' && job.view.phase === 'awaiting') void this.sendFile(job, message);
          break;
        case 'file.credit':
          if (job.view.direction === 'send' && (job.view.phase === 'transferring' || job.view.phase === 'verifying')) {
            const written = bytes(message.written);
            const through = bytes(message.through);
            if (written > job.sent || through < written || through - written > CREDIT_WINDOW ||
                through > bytes(job.view.file.size_bytes)) throw new Error('INVALID_FRAME');
            if (written < job.view.written || through < job.credit) return;
            job.view.written = written;
            job.credit = through;
            this.measure(job, written);
            this.arm(job);
            job.wake?.();
            this.emit(true);
          }
          break;
        case 'file.checkpoint':
          if (job.view.direction === 'send' && canResume(job.view.mode)) {
            const offset = bytes(message.offset);
            if (offset > job.sent || offset % CHECKPOINT) throw new Error('INVALID_FRAME');
            job.view.checkpoint = Math.max(job.view.checkpoint, offset);
          }
          break;
        case 'file.finish':
          if (job.view.direction !== 'receive' || job.view.phase !== 'transferring') return;
          if (message.size_bytes !== job.view.file.size_bytes ||
              (job.finish && job.finish.digest !== message.digest)) throw new Error('HASH_MISMATCH');
          job.finish = message;
          void this.drain(job);
          break;
        case 'file.commit':
          if (job.view.direction !== 'send' || (job.view.phase !== 'verifying' && !job.view.resume)) return;
          if (message.size_bytes !== job.view.file.size_bytes || !job.digest || message.digest !== job.digest) {
            throw new Error('HASH_MISMATCH');
          }
          job.view.written = bytes(job.view.file.size_bytes);
          job.view.sha256 = message.digest;
          void this.stop(job, message.saved ? 'saved' : 'stored');
          break;
        case 'file.reject':
          void this.stop(job, 'rejected', message.code);
          break;
        case 'file.cancel':
        case 'file.error':
          if (job.view.direction === 'receive' && job.view.phase === 'verifying') return;
          if (message.type === 'file.error' && message.code === 'QUOTA_EXCEEDED' &&
              job.view.direction === 'send' && job.view.mode === 'indexed-db') {
            void this.stop(job, 'paused', message.code);
          } else {
            void this.stop(job, message.type === 'file.cancel' ? 'cancelled' : 'failed', message.code);
          }
          break;
      }
    } catch (error) {
      void this.fail(job, codeOf(error));
    }
  }

  async accept(id: string, choice?: SaveChoice): Promise<void> {
    const job = this.jobs.get(id);
    if (!job?.pair || !job.offer || !this.isActive(job) || job.view.phase !== 'incoming') return;
    const pair = job.pair;
    const offer = job.offer;
    const size = bytes(job.view.file.size_bytes);
    const { roomId, peerId } = this.session;
    this.phase(job, 'preparing');
    this.arm(job, offer.type === 'file.resume' ? RESUME_TIMEOUT : undefined);
    try {
      const storage = this.options.storage;
      const handle = choice === 'direct' && offer.type !== 'file.resume'
        ? await storage.chooseFile?.(job.view.file.name) : undefined;
      if (!this.isActive(job)) return;
      if (choice === 'memory' && size + this.options.memoryUsed() > MEMORY_LIMIT) throw new Error('MEMORY_FULL');
      let entry: SavedRecord = {
        id, roomId, receiver: peerId, sender: job.view.peer, senderName: job.view.peerName,
        file: job.view.file, checkpoint: 0, prefix: null, digest: null, updatedAt: Date.now(),
        expiresAt: this.session.roomExpiresAt, mode: 'opfs-sync',
      };
      if (offer.type === 'file.resume') {
        await this.restore;
        const previous = (await storage.records().catch(() => []))
          .find((item) => item.id === id && item.roomId === roomId && item.receiver === peerId && item.sender === job.view.peer);
        if (!this.isActive(job)) return;
        const committed = previous?.digest ?? job.digest;
        if (committed && (!previous || sameFileInfo(previous.file, offer.file)) && committed === offer.full_digest) {
          if (previous?.digest) await storage.openStored(previous);
          if (!this.isActive(job)) return;
          const saved = Boolean(job.receiptSaved);
          if (!this.sendReceipt(pair, job, committed, saved)) throw new Error('CONNECTION_LOST');
          job.digest = committed;
          job.view.written = size;
          job.view.receivedAt ??= previous?.updatedAt;
          await this.stop(job, saved ? 'saved' : 'stored');
          return;
        }
        if (!previous || previous.digest || !canResume(previous.mode) || (previous.expiresAt ?? Infinity) <= Date.now() ||
            !sameFileInfo(previous.file, offer.file)) throw new Error('CHECKPOINT_MISMATCH');
        entry = previous;
        choice = previous.mode === 'indexed-db' ? 'indexed-db' : 'opfs';
        job.view.mode = previous.mode;
        job.view.checkpoint = previous.checkpoint;
      }
      if (!choice) throw new Error('STORAGE_UNAVAILABLE');
      const pipeline = storage.pipeline();
      job.pipeline = pipeline;
      const accepted = await pipeline.call<ReceiveStart>({ type: 'receive.start', choice, entry, resume: offer.type === 'file.resume', handle });
      if (!this.isActive(job)) return;
      job.view.mode = accepted.mode;
      job.view.written = accepted.offset;
      job.view.checkpoint = accepted.offset;
      job.received = accepted.offset;
      job.credit = Math.min(size, accepted.offset + CREDIT_WINDOW);
      job.input = { bytes: new Uint8Array(IO_BLOCK), used: 0, blocks: [], draining: false };
      this.phase(job, 'transferring');
      this.arm(job);
      pair.send({
        type: 'file.accept', transfer_id: id, mode: accepted.mode, offset: String(accepted.offset),
        prefix_digest: accepted.prefix, through: String(job.credit),
      });
    } catch (error) {
      if (!this.isActive(job)) return;
      const code = codeOf(error, 'STORAGE_UNAVAILABLE');
      if (offer.type === 'file.resume' || job.input) {
        await this.fail(job, code);
        return;
      }
      await job.pipeline?.release(false).catch(() => undefined);
      if (!this.isActive(job)) return;
      job.pipeline = undefined;
      this.phase(job, 'incoming', code);
      this.arm(job, 120_000);
    }
  }

  private async sendFile(job: Job<Source>, accepted: Acceptance): Promise<void> {
    const pair = job.pair;
    const channel = pair?.bulk;
    if (!pair || !channel || !job.source || !this.isActive(job)) return;
    this.phase(job, 'transferring');
    this.arm(job, job.view.resume ? RESUME_TIMEOUT : undefined);
    try {
      const size = bytes(job.view.file.size_bytes);
      const offset = bytes(accepted.offset);
      const through = bytes(accepted.through);
      if (offset > size || through < offset || through > size || through - offset > CREDIT_WINDOW ||
          (offset && (!job.view.resume || !canResume(accepted.mode) || offset % CHECKPOINT || !accepted.prefix_digest))) {
        throw new Error('CHECKPOINT_MISMATCH');
      }

      job.view.mode = accepted.mode;
      job.sent = offset;
      job.view.written = offset;
      job.view.checkpoint = offset;
      job.credit = through;
      const pipeline = this.options.storage.pipeline();
      job.pipeline = pipeline;
      await pipeline.call({ type: 'send.start', file: job.source, offset, prefix: accepted.prefix_digest });
      const frameMax = pair.maxMessage();
      while (this.isActive(job) && job.sent < size) {
        await this.awaitWindow(job, channel, frameMax, true);
        if (!this.isActive(job)) return;
        const length = Math.min(IO_BLOCK, job.credit - job.sent, size - job.sent);
        const block = new Uint8Array(await pipeline.call<ArrayBuffer>({ type: 'send.read', size: length }));
        for (let at = 0; at < block.byteLength;) {
          await this.awaitWindow(job, channel, frameMax, false);
          if (!this.isActive(job)) return;
          const count = Math.min(frameMax - HEADER_BYTES, block.byteLength - at);
          channel.send(encodeFrame(job.view.id, job.sent, block.subarray(at, at + count)));
          job.sent += count;
          at += count;
          this.arm(job);
        }
      }
      if (!this.isActive(job)) return;
      const digest = await pipeline.call<string>({ type: 'send.digest' });
      if (!this.isActive(job)) return;
      if (job.digest && job.digest !== digest) throw new Error('FILE_CHANGED');
      job.digest = digest;
      this.phase(job, 'verifying');
      pair.send({ type: 'file.finish', transfer_id: job.view.id, size_bytes: String(size), digest });
      this.arm(job);
    } catch (error) {
      if (this.isActive(job)) await this.fail(job, codeOf(error, 'CONNECTION_LOST'));
    }
  }

  private async awaitWindow(job: Job<Source>, channel: RTCDataChannel, frameMax: number, checkCredit: boolean): Promise<void> {
    while (this.isActive(job)) {
      if (channel.readyState !== 'open') throw new Error('CONNECTION_LOST');
      if (channel.bufferedAmount + frameMax <= SEND_HIGH_WATER && (!checkCredit || job.credit > job.sent)) return;
      await new Promise<void>((resolve) => {
        const wake = () => {
          channel.removeEventListener('bufferedamountlow', wake);
          job.wake = undefined;
          resolve();
        };
        job.wake = wake;
        channel.addEventListener('bufferedamountlow', wake, { once: true });
      });
    }
  }

  bulk(pair: Pair, raw: ArrayBuffer): void {
    if (this.closed) return;
    let job: Job<Source> | undefined;
    try {
      const frame = decodeFrame(raw);
      job = this.jobs.get(frame.id);
      if (!job || job.pair !== pair || job.view.direction !== 'receive') throw new Error('INVALID_FRAME');
      if (job.view.phase === 'verifying' || job.stopping || !this.isActive(job)) return;
      const input = job.input;
      if (job.view.phase !== 'transferring' || !input) throw new Error('INVALID_FRAME');
      if (input.last?.offset === frame.offset &&
          input.last.payload.byteLength === frame.payload.byteLength &&
          input.last.payload.every((value, index) => value === frame.payload[index])) return;
      if (frame.offset !== job.received || frame.offset + frame.payload.byteLength > job.credit) throw new Error('INVALID_FRAME');
      input.last = frame;
      job.received += frame.payload.byteLength;
      for (let at = 0; at < frame.payload.byteLength;) {
        const length = Math.min(IO_BLOCK - input.used, frame.payload.byteLength - at);
        input.bytes.set(frame.payload.subarray(at, at + length), input.used);
        input.used += length;
        at += length;
        if (input.used === IO_BLOCK) {
          input.blocks.push(input.bytes.buffer);
          input.bytes = new Uint8Array(IO_BLOCK);
          input.used = 0;
        }
      }
      if (input.used && job.received === bytes(job.view.file.size_bytes)) {
        input.blocks.push(input.bytes.buffer.slice(0, input.used));
        input.used = 0;
      }
      this.arm(job);
      void this.drain(job);
    } catch (error) {
      if (job && job.pair === pair && this.isActive(job)) void this.fail(job, codeOf(error, 'INVALID_FRAME'));
      else pair.close('PROTOCOL_MISMATCH');
    }
  }

  private async drain(job: Job<Source>): Promise<void> {
    const { input, pair, pipeline } = job;
    if (!input || !pair || !pipeline || input.draining || !this.isActive(job)) return;
    input.draining = true;
    try {
      const size = bytes(job.view.file.size_bytes);
      while (input.blocks.length && this.isActive(job)) {
        const block = input.blocks.shift()!;
        const result = await pipeline.call<ReceiveWrite>({ type: 'receive.write', block }, [block]);
        if (!this.isActive(job)) return;
        job.view.written = result.written;
        job.credit = Math.min(size, result.written + CREDIT_WINDOW);
        this.measure(job, result.written);
        if (result.checkpoint !== undefined && result.prefix) {
          job.view.checkpoint = result.checkpoint;
          pair.send({ type: 'file.checkpoint', transfer_id: job.view.id, offset: String(result.checkpoint), digest: result.prefix });
        }
        pair.send({ type: 'file.credit', transfer_id: job.view.id, written: String(result.written), through: String(job.credit) });
        this.emit(true);
      }
      if (!job.finish || job.view.written !== size || job.received !== size || !this.isActive(job)) return;
      const digest = job.finish.digest;
      if (job.offer?.type === 'file.resume' && job.offer.full_digest && job.offer.full_digest !== digest) throw new Error('HASH_MISMATCH');
      this.phase(job, 'verifying');
      const saved = job.view.mode === 'direct';
      const result = await pipeline.call<ReceiveResult>({ type: 'receive.commit', digest });
      job.digest = digest;
      job.receiptSaved = saved;
      job.view.sha256 = digest;
      job.view.localPath = result.path;
      const file = { id: job.view.id, file: job.view.file, senderName: job.view.peerName };
      job.view.receivedAt = result.entry?.updatedAt ?? Date.now();
      const staged = result.entry || result.file ? { ...file, entry: result.entry, memoryFile: result.file } : undefined;
      this.options.onReceived({ ...file, saved, receivedAt: job.view.receivedAt }, staged);
      await this.stop(job, saved ? 'saved' : 'stored');
      this.sendReceipt(pair, job, digest, saved);
    } catch (error) {
      if (this.isActive(job) || job.view.phase === 'verifying') await this.fail(job, codeOf(error, 'STORAGE_UNAVAILABLE'));
    } finally {
      input.draining = false;
    }
  }

  private sendReceipt(pair: Pair, job: Job<Source>, digest: string, saved: boolean): boolean {
    try {
      pair.send({ type: 'file.commit', transfer_id: job.view.id, size_bytes: job.view.file.size_bytes, digest, saved });
      return true;
    } catch { return false; }
  }

  private measure(job: Job<Source>, written: number): void {
    const now = performance.now();
    job.speedAt ??= now;
    job.speedBytes ??= written;
    if (now - job.speedAt >= 350) {
      job.view.speed = (written - job.speedBytes) * 1000 / (now - job.speedAt);
      job.speedAt = now;
      job.speedBytes = written;
    }
  }

  reject(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.view.phase !== 'incoming') return;
    this.sendIssue(job.pair, id, 'file.reject', 'USER_REJECTED');
    void this.stop(job, job.view.resume ? 'paused' : 'rejected', 'USER_REJECTED');
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.view.phase === 'verifying' ||
        (job.view.phase !== 'queued' && job.view.phase !== 'paused' && !this.isActive(job))) return;
    this.sendIssue(job.pair, id, 'file.cancel', 'USER_CANCELLED');
    void this.stop(job, 'cancelled', 'USER_CANCELLED');
  }

  retry(id: string, restart: boolean): void {
    const job = this.jobs.get(id);
    if (!job?.source || !job.view.canRetry) return;
    const peer = this.options.peer(job.view.peer);
    if (!peer) throw new Error('PEER_OFFLINE');
    if (restart) {
      this.enqueue(peer, [job.source]);
      job.view.canRetry = false;
      job.source = undefined;
      this.emit();
      return;
    }
    if (this.active) throw new Error('PEER_BUSY');
    if (!job.view.resume) throw new Error('CHECKPOINT_MISMATCH');
    job.stopping = false;
    job.sent = 0;
    job.credit = 0;
    job.speedAt = undefined;
    job.speedBytes = undefined;
    job.view.canRetry = false;
    void this.offer(job);
  }

  pairClosed(pair: Pair, code: string): void {
    const job = this.active;
    if (!job || job.pair !== pair || !this.isActive(job) ||
        (job.view.direction === 'receive' && job.view.phase === 'verifying')) return;
    void this.fail(job, code);
  }

  revoke(peer: string): void {
    for (const job of this.jobs.values()) {
      if (job.view.peer !== peer || job.view.phase === 'verifying') continue;
      if (activePhases.has(job.view.phase) || job.view.phase === 'paused' || job.view.phase === 'queued') {
        void this.stop(job, 'failed', 'MEMBER_REVOKED');
      }
    }
  }

  private sendIssue(pair: Pair | undefined, id: string, type: Issue, code: string): void {
    try { pair?.send({ type, transfer_id: id, code }); } catch { /* The peer observes the disconnect. */ }
  }

  private async fail(job: Job<Source>, code: string): Promise<void> {
    const quota = code === 'QUOTA_EXCEEDED' && job.view.mode === 'indexed-db';
    const recover = (resumableErrors.has(code) || quota) &&
      (canResume(job.view.mode) || Boolean(job.digest)) &&
      (job.view.phase !== 'preparing' || Boolean(job.view.resume));
    if (!recover || quota) this.sendIssue(job.pair, job.view.id, 'file.error', code);
    const stopping = this.stop(job, recover ? 'paused' : 'failed', code);
    if (recover && code === 'TIMEOUT') job.pair?.close('CONNECTION_LOST');
    await stopping;
  }

  private async stop(job: Job<Source>, state: Phase, code?: string): Promise<void> {
    if (job.stopping) return;
    const prior = job.view.phase;
    const preserve = state === 'paused';
    job.stopping = true;
    clearTimeout(job.timer);
    job.wake?.();
    const pipe = job.pipeline;
    job.pipeline = undefined;
    job.input = undefined;
    job.view.speed = undefined;
    job.view.resume = preserve && job.view.direction === 'send';
    job.view.canRetry = Boolean(job.source && (state === 'paused' || state === 'failed' || state === 'rejected') &&
      code !== 'MEMBER_REVOKED' && code !== 'ROOM_CLOSED');
    if (!job.view.canRetry) job.source = undefined;
    this.phase(job, state, code);
    await pipe?.release(preserve || code === 'CHECKPOINT_MISMATCH').catch(() => undefined);
    if (job.view.direction === 'receive' && !preserve && !receiptPhases.has(state) && !job.digest &&
        (prior === 'paused' || (job.offer?.type === 'file.resume' && code !== 'CHECKPOINT_MISMATCH'))) {
      await this.options.storage.discardPartial(job.view.id).catch(() => undefined);
    }
    job.stopping = false;
    if (this.active === job) {
      this.active = undefined;
      this.trimHistory();
      this.next();
    }
  }

  private trimHistory(): void {
    const limit = this.options.historyLimit;
    if (limit === undefined || this.jobs.size <= limit) return;
    for (const [id, { view }] of this.jobs) {
      if (view.phase === 'queued' || activePhases.has(view.phase)) continue;
      this.jobs.delete(id);
      if (this.jobs.size <= limit) break;
    }
    this.emit();
  }

  destroy(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.renderTimer);
    const keepCheckpoints = reason === 'PAGE_CLOSED' || reason === 'SESSION_REPLACED';
    for (const job of this.jobs.values()) {
      if (job.view.direction === 'receive' && job.view.phase === 'verifying') continue;
      if (this.active === job || (!keepCheckpoints && job.view.phase === 'paused')) {
        void this.stop(job, keepCheckpoints && canResume(job.view.mode) ? 'paused' : 'failed', reason);
      }
    }
  }
}

