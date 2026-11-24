export const VERSION = 1;
export const PROTOCOL = 'file-room/1';
export const SOCKET_PROTOCOL = 'file-room.v1';
export const ROOM_CAPACITY = 8;
export const INVITE_TTL = 10 * 60_000;
export const ROOM_TTL = 2 * 60 * 60_000;
export const EMPTY_ROOM_TTL = 10 * 60_000;
export const MAX_SIGNAL_BYTES = 64 * 1024;
export const MAX_BATCH_FILES = 16;
export const MAX_DEVICE_NAME_LENGTH = 48;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function roomPage(pathname: string): { kind: 'join' | 'room'; id: string } | undefined {
  const match = /^\/(join|room)\/([^/]+)$/.exec(pathname);
  if (!match || !ROOM_ID.test(match[2])) return;
  return { kind: match[1] === 'join' ? 'join' : 'room', id: match[2] };
}

export type DeviceKind = 'desktop' | 'android' | 'iphone' | 'tablet' | 'other';
export interface Device { name: string; kind: DeviceKind }
export interface Member extends Device {
  id: string;
  instance: string;
  host: boolean;
}
export interface Invite { secret: string; expiresAt: number }
export interface Session {
  roomId: string;
  peerId: string;
  token: string;
  roomExpiresAt: number;
  adminToken?: string;
  invite?: Invite;
}
export interface ShareSummary {
  id: string;
  ownerId: string;
  to?: string;
  count: number;
  size: string;
  expiresAt: number;
}

type SignalBody =
  | { type: 'connect.request'; payload: null }
  | { type: 'rtc.offer'; payload: { type: 'offer'; sdp: string } }
  | { type: 'rtc.answer'; payload: { type: 'answer'; sdp: string } }
  | { type: 'rtc.ice'; payload: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment: string | null } };

export type Signal = SignalBody & {
  v: 1;
  room_id: string;
  to: string;
  to_instance: string;
  pair_id: string;
  connection_epoch: string;
  seq: number;
};

export type RoomEvent =
  | { type: 'room.snapshot'; members: Member[]; shares: ShareSummary[]; expiresAt: number }
  | { type: 'room.revoked'; peerId: string }
  | { type: 'room.closed'; code: string }
  | { type: 'share.request'; shareId: string; from: string }
  | { type: 'error'; code: string; peerId?: string }
  | (Signal & { from: string; from_instance: string });

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('BAD_REQUEST');
  return value as Record<string, unknown>;
}

export function bytes(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new Error('BAD_REQUEST');
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('BAD_REQUEST');
  return result;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function readDeviceName(value: unknown): string {
  const name = typeof value === 'string' ? cleanLabel(value).trim() : '';
  if (!name || name.length > MAX_DEVICE_NAME_LENGTH) throw new Error('BAD_REQUEST');
  return name;
}

export function readDevice(value: Record<string, unknown>): Device {
  const name = readDeviceName(value.name);
  const kind = value.kind;
  if (!['desktop', 'android', 'iphone', 'tablet', 'other'].includes(String(kind))) {
    throw new Error('BAD_REQUEST');
  }
  return { name, kind: kind as DeviceKind };
}

export function cleanLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}

export function pairId(left: string, right: string): string {
  return left < right ? left + '.' + right : right + '.' + left;
}

function relayCandidate(value: string): boolean {
  return /(?:^|\s)typ\s+relay(?:\s|$)/im.test(value);
}

export function readSignal(data: Record<string, unknown>, roomId: string, from: string): Signal {
  const { type, to, to_instance, pair_id, connection_epoch, seq } = data;
  if (data.v !== VERSION || data.room_id !== roomId || !isUuid(to) || to === from || !isUuid(to_instance) ||
      pair_id !== pairId(from, to) || !isUuid(connection_epoch) || typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) || seq < 1) throw new Error('BAD_REQUEST');
  const envelope = { v: VERSION as 1, room_id: roomId, to, to_instance, pair_id, connection_epoch, seq };
  if (type === 'connect.request' && from > to) return { ...envelope, type, payload: null };
  const payload = record(data.payload);
  if (type === 'rtc.offer' || type === 'rtc.answer') {
    const sdp = payload.sdp;
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0') ||
        (type === 'rtc.offer' ? from > to : from < to)) throw new Error('BAD_REQUEST');
    if (relayCandidate(sdp)) throw new Error('RELAY_NOT_ALLOWED');
    return type === 'rtc.offer' ? { ...envelope, type, payload: { type: 'offer', sdp } }
      : { ...envelope, type, payload: { type: 'answer', sdp } };
  }
  if (type !== 'rtc.ice' || typeof payload.candidate !== 'string' || payload.candidate.length > 2048 ||
      !payload.candidate.startsWith('candidate:')) throw new Error('BAD_REQUEST');
  if (relayCandidate(payload.candidate)) throw new Error('RELAY_NOT_ALLOWED');
  const mid = payload.sdpMid;
  const index = payload.sdpMLineIndex;
  const fragment = payload.usernameFragment;
  if (mid != null && (typeof mid !== 'string' || mid.length > 128) ||
      index != null && (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 65535) ||
      fragment != null && (typeof fragment !== 'string' || fragment.length > 256)) throw new Error('BAD_REQUEST');
  return {
    ...envelope, type, payload: {
      candidate: payload.candidate,
      sdpMid: mid ?? null,
      sdpMLineIndex: index ?? null,
      usernameFragment: fragment ?? null,
    },
  };
}
