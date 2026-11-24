import { SOCKET_PROTOCOL, TOKEN, VERSION, randomId, roomPage } from '../shared/room.ts';
import type { Device, Invite, RoomEvent, Session } from '../shared/room.ts';

const base = '/api/v1/rooms';
const terminal = new Set(['ROOM_CLOSED', 'MEMBER_REVOKED', 'SESSION_REPLACED']);

export async function api<T>(path: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const { method = 'GET', token, body } = options;
  const headers = new Headers({ Accept: 'application/json' });
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if (body) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('SIGNAL_DISCONNECTED');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.code || 'SERVER_ERROR');
  return data as T;
}

export const createRoom = (device: Device) => api<Session>('', { method: 'POST', body: device });
export const joinRoom = (roomId: string, device: Device, secret: string) =>
  api<Session>('/' + roomId + '/join', { method: 'POST', body: { ...device, invite: secret } });
export async function renameMember(session: Session, name: string): Promise<void> {
  await api('/' + session.roomId + '/members/self', { method: 'PATCH', token: session.token, body: { name } });
}

export function inviteLink(roomId: string, invite: Invite): string {
  return location.origin + '/join/' + roomId + '#invite=' + invite.secret;
}

export function parseInvite(raw: string): { roomId: string; secret: string } {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('INVALID_INVITE'); }
  const page = roomPage(url.pathname);
  const secret = new URLSearchParams(url.hash.slice(1)).get('invite');
  if (url.origin !== location.origin || page?.kind !== 'join' || !secret || !TOKEN.test(secret)) {
    throw new Error('INVALID_INVITE');
  }
  return { roomId: page.id, secret };
}

export function saveSession(session: Session): void {
  try { sessionStorage.setItem('file-room:' + session.roomId, JSON.stringify(session)); } catch { /* Private mode. */ }
}
export function getSession(roomId: string): Session | undefined {
  try {
    const session = JSON.parse(sessionStorage.getItem('file-room:' + roomId) ?? 'null') as Session | null;
    if (session?.roomId === roomId && TOKEN.test(session.token)) return session;
  } catch { /* A new device can use its invitation. */ }
}
export function clearSession(roomId: string): void {
  try { sessionStorage.removeItem('file-room:' + roomId); } catch { /* Private mode. */ }
}

export type SignalStatus = 'connecting' | 'online' | 'reconnecting';

export class RoomClient {
  readonly instance = randomId();
  private socket?: WebSocket;
  private destroyed = false;
  private retries = 0;
  private retryTimer?: number;

  constructor(
    readonly session: Session,
    private readonly onEvent: (event: RoomEvent) => void,
    private readonly onStatus: (status: SignalStatus) => void,
  ) {}

  start(): void {
    if (this.destroyed) return;
    const url = new URL(base + '/' + this.session.roomId + '/socket', location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('instance', this.instance);
    const socket = new WebSocket(url, [SOCKET_PROTOCOL, 'auth.' + this.session.token]);
    this.socket = socket;
    socket.onmessage = (message) => {
      if (this.destroyed || this.socket !== socket || typeof message.data !== 'string') return;
      let event: RoomEvent;
      try { event = JSON.parse(message.data) as RoomEvent; } catch { return; }
      if (event.type === 'room.snapshot') {
        this.retries = 0;
        this.onStatus('online');
      }
      this.onEvent(event);
    };
    socket.onclose = (event) => {
      if (!this.destroyed && this.socket === socket) void this.reconnect(event.reason);
    };
  }

  private async reconnect(reason: string): Promise<void> {
    if (terminal.has(reason)) {
      this.onEvent({ type: 'room.closed', code: reason });
      return;
    }
    this.onStatus('reconnecting');
    try {
      await api('/' + this.session.roomId + '/session', { token: this.session.token });
    } catch (error) {
      if (this.destroyed) return;
      const code = error instanceof Error ? error.message : '';
      if (terminal.has(code)) {
        this.onEvent({ type: 'room.closed', code });
        return;
      }
    }
    if (this.destroyed) return;
    const delay = Math.min(1000 * 2 ** this.retries++, 15_000);
    this.retryTimer = window.setTimeout(() => this.start(), delay);
  }

  send<T extends { type: string }>(body: T): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('SIGNAL_DISCONNECTED');
    this.socket.send(JSON.stringify({ ...body, v: VERSION }));
  }

  destroy(): void {
    this.destroyed = true;
    window.clearTimeout(this.retryTimer);
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

