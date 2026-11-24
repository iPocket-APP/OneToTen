import { PROTOCOL, VERSION, bytes, cleanLabel, isUuid, record } from '../shared/room.ts';

export const HEADER_BYTES = 48;
export const PREFERRED_FRAME = 16 * 1024;
export const SEND_HIGH_WATER = 1024 * 1024;
export const SEND_LOW_WATER = 256 * 1024;
export const CREDIT_WINDOW = 4 * 1024 * 1024;
export const IO_BLOCK = 256 * 1024;
export const CHECKPOINT = 1024 * 1024;
export const MEMORY_LIMIT = 32 * 1024 * 1024;
export const OPFS_LIMIT = 512 * 1024 * 1024;
export const INDEXED_DB_LIMIT = 4 * 1024 ** 3;
export const TEXT_LIMIT = 12 * 1024;
const MAGIC = 0x46524d31;
const utf8 = new TextEncoder();

export type StagingMode = 'opfs-sync' | 'opfs-stream' | 'indexed-db';
export type SaveMode = 'direct' | StagingMode | 'memory';
export type SaveChoice = 'direct' | 'opfs' | 'indexed-db' | 'memory';

export function canResume(mode: SaveMode | undefined): boolean {
  return mode === 'opfs-sync' || mode === 'indexed-db';
}

export interface FileInfo {
  name: string;
  size_bytes: string;
  mime: string;
  last_modified_ms: number;
}
export type FileSource = Pick<File, 'name' | 'size' | 'type' | 'lastModified'>;
export type TransferControl = { transfer_id: string } & (
  | { type: 'file.offer'; file: FileInfo; integrity: { algorithm: 'sha256'; checkpoint_bytes: number } }
  | { type: 'file.resume'; file: FileInfo; full_digest: string | null }
  | { type: 'file.accept'; mode: SaveMode; offset: string; prefix_digest: string | null; through: string }
  | { type: 'file.credit'; written: string; through: string }
  | { type: 'file.checkpoint'; offset: string; digest: string }
  | { type: 'file.finish' | 'file.commit'; size_bytes: string; digest: string; saved?: boolean }
  | { type: 'file.reject' | 'file.cancel' | 'file.error'; code: string }
);
export type TextControl =
  | { type: 'text.message'; message_id: string; text: string }
  | { type: 'text.ack'; message_id: string };
export type Control = TransferControl | TextControl
  | { type: 'hello'; protocol: typeof PROTOCOL; modes: SaveMode[]; text?: true }
  | { type: 'hello.ack'; protocol: typeof PROTOCOL };

export function textTooLong(text: string): boolean {
  // Leave room for the control envelope, including when the text has JSON escapes.
  return text.length > TEXT_LIMIT || utf8.encode(JSON.stringify(text)).byteLength - 2 > TEXT_LIMIT;
}

export function safeFilename(name: string): string {
  const cleaned = cleanLabel(name).replace(/[<>:"/\\|?*]/g, '_').trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  const points = [...cleaned];
  if (points.length <= 180) return cleaned || 'file';
  const extension = /\.[A-Za-z0-9_-]{1,16}$/.exec(cleaned)?.[0] ?? '';
  return points.slice(0, 180 - extension.length).join('') + extension;
}

export function fileInfo(file: FileSource): FileInfo {
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('FILE_TOO_LARGE');
  return {
    name: safeFilename(file.name),
    size_bytes: String(file.size),
    mime: file.type.slice(0, 120),
    last_modified_ms: file.lastModified,
  };
}

export function sameFileInfo(left: FileInfo, right: FileInfo): boolean {
  return left.name === right.name && left.size_bytes === right.size_bytes &&
    left.last_modified_ms === right.last_modified_ms && left.mime === right.mime;
}

export function messageLimit(sctpMax: number | undefined): number {
  if (sctpMax === undefined || !(sctpMax > HEADER_BYTES)) throw new Error('MESSAGE_TOO_LARGE');
  return Math.floor(Math.min(PREFERRED_FRAME, sctpMax));
}

export function encodeControl(message: Control, max: number): string {
  const raw = JSON.stringify({ v: VERSION, ...message });
  if (utf8.encode(raw).byteLength > max) throw new Error('MESSAGE_TOO_LARGE');
  return raw;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('BAD_REQUEST');
  return value;
}

function readMode(mode: unknown): SaveMode {
  if (mode === 'direct' || mode === 'opfs-sync' || mode === 'opfs-stream' || mode === 'indexed-db' || mode === 'memory') return mode;
  throw new Error('BAD_REQUEST');
}

export function decodeControl(raw: unknown): Control {
  if (typeof raw !== 'string' || raw.length > PREFERRED_FRAME || utf8.encode(raw).byteLength > PREFERRED_FRAME) {
    throw new Error('MESSAGE_TOO_LARGE');
  }
  const data = record(JSON.parse(raw));
  if (data.v !== VERSION) throw new Error('PROTOCOL_MISMATCH');
  const { type, transfer_id } = data;
  if (type === 'hello' && data.protocol === PROTOCOL && Array.isArray(data.modes) && data.modes.length <= 4) {
    return { type, protocol: PROTOCOL, modes: data.modes.map(readMode), ...(data.text === true ? { text: true } : {}) };
  }
  if (type === 'hello.ack' && data.protocol === PROTOCOL) return { type, protocol: PROTOCOL };
  if (type === 'text.message' || type === 'text.ack') {
    const { message_id, text } = data;
    if (!isUuid(message_id)) throw new Error('BAD_REQUEST');
    if (type === 'text.ack') return { type, message_id };
    if (typeof text !== 'string' || !text.trim()) throw new Error('BAD_REQUEST');
    if (textTooLong(text)) throw new Error('TEXT_TOO_LONG');
    return { type, message_id, text };
  }
  if (!isUuid(transfer_id)) throw new Error('BAD_REQUEST');
  switch (type) {
    case 'file.offer':
    case 'file.resume': {
      const f = record(data.file);
      if (typeof f.name !== 'string' || !f.name || f.name.length > 360 ||
          typeof f.mime !== 'string' || f.mime.length > 120 ||
          typeof f.last_modified_ms !== 'number' || !Number.isSafeInteger(f.last_modified_ms)) throw new Error('BAD_REQUEST');
      const file = {
        name: safeFilename(f.name),
        size_bytes: String(bytes(f.size_bytes)),
        mime: f.mime,
        last_modified_ms: f.last_modified_ms,
      };
      if (type === 'file.resume') {
        return { type, transfer_id, file, full_digest: data.full_digest === null ? null : hash(data.full_digest) };
      }
      const integrity = record(data.integrity);
      if (integrity.algorithm !== 'sha256' || integrity.checkpoint_bytes !== CHECKPOINT) throw new Error('PROTOCOL_MISMATCH');
      return { type, transfer_id, file, integrity: { algorithm: 'sha256', checkpoint_bytes: CHECKPOINT } };
    }
    case 'file.accept':
      return {
        type, transfer_id, mode: readMode(data.mode), offset: String(bytes(data.offset)),
        prefix_digest: data.prefix_digest === null ? null : hash(data.prefix_digest), through: String(bytes(data.through)),
      };
    case 'file.credit':
      return { type, transfer_id, written: String(bytes(data.written)), through: String(bytes(data.through)) };
    case 'file.checkpoint':
      return { type, transfer_id, offset: String(bytes(data.offset)), digest: hash(data.digest) };
    case 'file.finish':
    case 'file.commit':
      if (type === 'file.commit' && typeof data.saved !== 'boolean') throw new Error('BAD_REQUEST');
      return { type, transfer_id, size_bytes: String(bytes(data.size_bytes)), digest: hash(data.digest),
        saved: type === 'file.commit' ? data.saved as boolean : undefined };
    case 'file.reject':
    case 'file.cancel':
    case 'file.error':
      if (typeof data.code !== 'string' || !/^[A-Z_]{1,40}$/.test(data.code)) throw new Error('BAD_REQUEST');
      return { type, transfer_id, code: data.code };
    default:
      throw new Error('PROTOCOL_MISMATCH');
  }
}

export function encodeFrame(id: string, offset: number, payload: Uint8Array): ArrayBuffer {
  if (!isUuid(id) || !Number.isSafeInteger(offset) || offset < 0 ||
      payload.byteLength < 1 || payload.byteLength > PREFERRED_FRAME - HEADER_BYTES) throw new Error('INVALID_FRAME');
  const result = new ArrayBuffer(HEADER_BYTES + payload.byteLength);
  const view = new DataView(result);
  view.setUint32(0, MAGIC);
  view.setUint8(4, VERSION);
  view.setUint8(5, 1);
  const plain = id.replaceAll('-', '');
  for (let i = 0; i < 16; i++) view.setUint8(8 + i, parseInt(plain.slice(i * 2, i * 2 + 2), 16));
  view.setBigUint64(24, BigInt(offset));
  view.setUint32(32, payload.byteLength);
  new Uint8Array(result, HEADER_BYTES).set(payload);
  return result;
}

export function decodeFrame(buffer: ArrayBuffer): { id: string; offset: number; payload: Uint8Array<ArrayBuffer> } {
  if (buffer.byteLength <= HEADER_BYTES || buffer.byteLength > PREFERRED_FRAME) throw new Error('INVALID_FRAME');
  const view = new DataView(buffer);
  const offset = Number(view.getBigUint64(24));
  const length = view.getUint32(32);
  if (view.getUint32(0) !== MAGIC || view.getUint8(4) !== VERSION || view.getUint8(5) !== 1 ||
      view.getUint16(6) !== 0 || view.getUint32(36) !== 0 || view.getBigUint64(40) !== 0n ||
      !Number.isSafeInteger(offset) || length !== buffer.byteLength - HEADER_BYTES) throw new Error('INVALID_FRAME');
  const parts = Array.from(new Uint8Array(buffer, 8, 16), (value) => value.toString(16).padStart(2, '0'));
  for (const end of [10, 8, 6, 4]) parts.splice(end, 0, '-');
  return { id: parts.join(''), offset, payload: new Uint8Array(buffer, HEADER_BYTES) };
}
