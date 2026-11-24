import { EventEmitter } from 'node:events';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import WebSocket from 'ws';
import { Pairs } from '../browser/pairs.ts';
import { Transfers } from '../browser/transfers.ts';
import type { TransferView } from '../browser/transfers.ts';
import { ROOM_ID, SOCKET_PROTOCOL, TOKEN, isUuid, randomId, readDeviceName, roomPage } from '../shared/room.ts';
import type { Invite, Member, RoomEvent, Session, Signal } from '../shared/room.ts';
import { DiskStorage, MAX_FILE_BYTES, diskSource } from './files.ts';

const apiPath = '/api/v1/rooms';
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const terminal = new Set(['MEMBER_REVOKED', 'ROOM_CLOSED', 'SESSION_REPLACED', 'RATE_LIMITED']);
const finalPhases = new Set(['saved', 'stored', 'paused', 'rejected', 'failed', 'cancelled']);

interface RoomOptions {
  origin: string;
  name: string;
  inbox: string;
  stun?: string;
}

type Peer = Pick<Member, 'id' | 'name' | 'kind' | 'host'>;

export function serverOrigin(raw: string, allowHttp: boolean): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('INVALID_SERVER'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('INVALID_SERVER');
  if (url.protocol === 'http:' && !allowHttp && !loopback.has(url.hostname)) throw new Error('HTTPS_REQUIRED');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('INVALID_SERVER');
  return url.origin;
}

export function invitation(raw: string, expectedOrigin: string | undefined, allowHttp: boolean) {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('INVALID_INVITE'); }
  const page = roomPage(url.pathname);
  const [secret, extra] = new URLSearchParams(url.hash.slice(1)).getAll('invite');
  if (url.username || url.password || url.search || page?.kind !== 'join' || !secret || extra !== undefined ||
      !TOKEN.test(secret) || (expectedOrigin && url.origin !== expectedOrigin)) throw new Error('INVALID_INVITE');
  return { origin: serverOrigin(url.origin, allowHttp), id: page.id, secret };
}

function device(name: string) {
  try { return { name: readDeviceName(name), kind: 'desktop' }; }
  catch { throw new Error('INVALID_DEVICE_NAME'); }
}

function checkedInvite(value: Invite | undefined): Invite {
  if (!value || !TOKEN.test(value.secret) || !Number.isSafeInteger(value.expiresAt)) throw new Error('SERVER_ERROR');
  return value;
}

function checkedSession(session: Session, expectedRoom?: string): Session {
  if (!session || !ROOM_ID.test(session.roomId) || !isUuid(session.peerId) || !TOKEN.test(session.token) ||
      !Number.isSafeInteger(session.roomExpiresAt) || (expectedRoom && session.roomId !== expectedRoom)) {
    throw new Error('SERVER_ERROR');
  }
  if (!expectedRoom) {
    if (!session.adminToken || !TOKEN.test(session.adminToken)) throw new Error('SERVER_ERROR');
    checkedInvite(session.invite);
  }
  return session;
}

async function request<T>(origin: string, path: string, body?: object, token?: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await fetch(origin + apiPath + path, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'application/json', Origin: origin, ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw new Error(timeout.aborted ? 'TIMEOUT' : 'SIGNAL_DISCONNECTED');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data?.code;
    throw new Error(typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : 'SERVER_ERROR');
  }
  return data as T;
}

function isFinal(transfer: TransferView): boolean {
  return finalPhases.has(transfer.phase);
}

export function succeeded(transfer: TransferView): boolean {
  return transfer.phase === 'saved' || transfer.phase === 'stored';
}

export class AgentRoom {
  private readonly instance = randomId();
  private readonly changes = new EventEmitter();
  private readonly storage: DiskStorage;
  private readonly pairs: Pairs;
  private readonly transfers: Transfers<Awaited<ReturnType<typeof diskSource>>>;
  private socket?: WebSocket;
  private members: Member[] = [];
  private online = false;
  private stopped?: string;
  private closing?: Promise<void>;
  private invite?: Invite;
  private rotating = false;

  private constructor(private readonly options: RoomOptions, private readonly session: Session) {
    this.invite = session.invite;
    this.storage = new DiskStorage(options.inbox);
    const getPeer = (id: string) => this.members.find((member) => member.id === id);
    this.pairs = new Pairs({ session, send: (signal) => this.sendSignal(signal) }, getPeer, {
      modes: () => ['direct'],
      control: (pair, message) => {
        if (message.type === 'text.message' || message.type === 'text.ack') return;
        if ((message.type === 'file.offer' || message.type === 'file.resume') && Number(message.file.size_bytes) > MAX_FILE_BYTES) {
          pair.send({ type: 'file.reject', transfer_id: message.transfer_id, code: 'FILE_TOO_LARGE' });
          return;
        }
        if (message.type === 'file.resume') {
          const previous = this.transfer(message.transfer_id);
          if (previous?.phase !== 'saved' || previous.peer !== pair.peer.id) {
            pair.send({ type: 'file.reject', transfer_id: message.transfer_id, code: 'CHECKPOINT_MISMATCH' });
            return;
          }
        }
        this.transfers.control(pair, message);
      },
      bulk: (pair, buffer) => this.transfers.bulk(pair, buffer),
      close: (pair, code) => this.transfers.pairClosed(pair, code),
    }, () => new RTCPeerConnection({ iceServers: options.stun ? [{ urls: options.stun }] : [] }));
    this.transfers = new Transfers(session, {
      storage: this.storage, historyLimit: 100, connect: (id) => this.pairs.ensure(id), peer: getPeer,
      onChange: () => this.changes.emit('change'),
      memoryUsed: () => 0, onReceived: () => undefined,
    });
  }

  static async create(options: RoomOptions, signal?: AbortSignal): Promise<AgentRoom> {
    const session = checkedSession(await request<Session>(options.origin, '', device(options.name), undefined, signal));
    return new AgentRoom(options, session).connect(signal);
  }

  static async join(options: RoomOptions, invite: ReturnType<typeof invitation>, signal?: AbortSignal): Promise<AgentRoom> {
    const session = checkedSession(await request<Session>(options.origin, '/' + invite.id + '/join',
      { ...device(options.name), invite: invite.secret }, undefined, signal), invite.id);
    return new AgentRoom(options, session).connect(signal);
  }

  private async connect(signal?: AbortSignal): Promise<this> {
    const { origin } = this.options;
    const url = new URL(apiPath + '/' + this.session.roomId + '/socket', origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('instance', this.instance);
    try {
      const socket = new WebSocket(url, [SOCKET_PROTOCOL, 'auth.' + this.session.token], {
        origin, handshakeTimeout: 10_000, maxPayload: 128 * 1024, perMessageDeflate: false,
      });
      this.socket = socket;
      socket.on('message', (data, binary) => {
        if (binary || this.stopped) return;
        try { this.event(JSON.parse(data.toString()) as RoomEvent); }
        catch { void this.close('PROTOCOL_MISMATCH'); }
      });
      socket.on('error', () => void this.close('SIGNAL_DISCONNECTED'));
      socket.on('close', (_, reason) => {
        const code = reason.toString();
        void this.close(terminal.has(code) ? code : 'SIGNAL_DISCONNECTED');
      });
      const timeout = AbortSignal.timeout(12_000);
      await this.waitFor(() => this.online ? true : undefined, signal ? AbortSignal.any([signal, timeout]) : timeout);
      return this;
    } catch (error) {
      await this.close('SIGNAL_DISCONNECTED');
      throw error;
    }
  }

  private event(event: RoomEvent): void {
    switch (event.type) {
      case 'room.snapshot':
        if (!event.members.some(({ id, instance }) => id === this.session.peerId && instance === this.instance)) {
          void this.close('SESSION_REPLACED');
          return;
        }
        this.members = event.members;
        this.online = true;
        this.pairs.membersChanged(event.members);
        this.changes.emit('change');
        return;
      case 'room.revoked':
        this.pairs.closePeer(event.peerId, 'MEMBER_REVOKED');
        this.transfers.revoke(event.peerId);
        return;
      case 'room.closed':
        void this.close(terminal.has(event.code) ? event.code : 'SIGNAL_DISCONNECTED');
        return;
      case 'error':
        if (event.code === 'ROOM_CLOSED') void this.close('ROOM_CLOSED');
        else if (event.peerId) this.pairs.closePeer(event.peerId, event.code);
        return;
      case 'share.request':
        return;
      default:
        this.pairs.signal(event);
    }
  }

  private sendSignal(signal: Signal): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('SIGNAL_DISCONNECTED');
    this.socket.send(JSON.stringify(signal));
  }

  private requireOnline(): void {
    if (!this.online || this.stopped) throw new Error(this.stopped ?? 'SIGNAL_DISCONNECTED');
  }

  private onlinePeers(): Member[] {
    return this.members.filter(({ id }) => id !== this.session.peerId);
  }

  peers(): Peer[] {
    return this.onlinePeers().map(({ id, name, kind, host }) => ({ id, name, kind, host }));
  }

  private recipient(to: string): Member {
    const peers = this.onlinePeers();
    const idMatch = peers.find(({ id }) => id === to);
    if (idMatch) return idMatch;
    const matches = peers.filter(({ name }) => name === to);
    if (matches.length > 1) throw new Error('AMBIGUOUS_PEER');
    if (!matches.length) throw new Error('PEER_OFFLINE');
    return matches[0];
  }

  status() {
    return {
      status: this.online ? 'online' : 'closed', code: this.stopped,
      roomId: this.session.roomId, peerId: this.session.peerId, expiresAt: this.session.roomExpiresAt,
      ...(this.online ? this.inviteDetails() : {}), inbox: this.options.inbox, peers: this.peers(),
      transfers: this.transfers.views().map((view) => this.visibleTransfer(view)),
    };
  }

  private inviteDetails() {
    if (!this.invite) return {};
    return {
      invitation: this.invite.expiresAt > Date.now()
        ? this.options.origin + '/join/' + this.session.roomId + '#invite=' + this.invite.secret : undefined,
      inviteExpiresAt: this.invite.expiresAt,
    };
  }

  async rotateInvite(signal?: AbortSignal) {
    this.requireOnline();
    if (!this.session.adminToken) throw new Error('NOT_ROOM_HOST');
    if (this.rotating) throw new Error('INVITE_ROTATING');
    this.rotating = true;
    try {
      this.invite = checkedInvite(await request<Invite>(this.options.origin, '/' + this.session.roomId + '/invites/rotate',
        undefined, this.session.adminToken, signal));
      this.requireOnline();
      return this.inviteDetails();
    } finally { this.rotating = false; }
  }

  async send(to: string, paths: string[], root?: string, signal?: AbortSignal): Promise<string[]> {
    this.requireOnline();
    const target = this.recipient(to);
    const files = await Promise.all(paths.map((path) => diskSource(path, root)));
    signal?.throwIfAborted();
    this.requireOnline();
    const current = this.onlinePeers().find(({ id, instance }) => id === target.id && instance === target.instance);
    if (!current) throw new Error('PEER_OFFLINE');
    return this.transfers.enqueue(current, files);
  }

  transfer(id: string): TransferView | undefined {
    const view = this.transfers.view(id);
    return view && this.visibleTransfer(view);
  }

  private visibleTransfer(view: TransferView): TransferView {
    if (this.stopped && !isFinal(view)) return { ...view, phase: 'failed', code: this.stopped };
    return view;
  }

  accept(id: string): void {
    this.requireOnline();
    if (this.transfer(id)?.phase !== 'incoming') throw new Error('OFFER_UNAVAILABLE');
    void this.transfers.accept(id, 'direct');
  }

  reject(id: string): void {
    this.requireOnline();
    if (this.transfer(id)?.phase !== 'incoming') throw new Error('OFFER_UNAVAILABLE');
    this.transfers.reject(id);
  }

  cancel(id: string): void {
    this.requireOnline();
    const transfer = this.transfer(id);
    if (!transfer || transfer.phase === 'verifying' || isFinal(transfer)) throw new Error('TRANSFER_UNAVAILABLE');
    this.transfers.cancel(id);
  }

  waitForOffer(from: string | undefined, signal: AbortSignal): Promise<TransferView> {
    return this.waitFor(() => this.transfers.views().find((item) =>
      item.phase === 'incoming' && (!from || item.peer === from)), signal);
  }

  waitForTransfer(id: string, signal: AbortSignal): Promise<TransferView> {
    return this.waitFor(() => {
      const transfer = this.transfer(id);
      if (!transfer) throw new Error('TRANSFER_UNAVAILABLE');
      return isFinal(transfer) || (transfer.phase === 'incoming' && transfer.code) ? transfer : undefined;
    }, signal);
  }

  waitFor<T>(read: () => T | undefined, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener('abort', check);
        this.changes.off('change', check);
      };
      const check = () => {
        try {
          signal?.throwIfAborted();
          const value = read();
          if (value !== undefined) { cleanup(); resolve(value); }
          else if (this.stopped) throw new Error(this.stopped);
        } catch (error) { cleanup(); reject(error); }
      };
      this.changes.on('change', check);
      signal?.addEventListener('abort', check, { once: true });
      check();
    });
  }

  close(code = 'ROOM_LEFT'): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = code;
    this.online = false;
    this.members = [];
    this.transfers.destroy(code);
    this.pairs.destroy(code);
    this.socket?.terminate();
    this.changes.emit('change');
    this.closing = this.storage.drained();
    return this.closing;
  }
}
