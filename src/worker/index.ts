import { DurableObject } from 'cloudflare:workers';
import {
  EMPTY_ROOM_TTL, INVITE_TTL, MAX_BATCH_FILES, MAX_SIGNAL_BYTES, ROOM_CAPACITY, ROOM_ID,
  ROOM_TTL, SOCKET_PROTOCOL, TOKEN, VERSION, bytes, isUuid, readDevice, readDeviceName, readSignal, record, roomPage,
} from '../shared/room.ts';
import type { Device, Invite, Member, RoomEvent, Session, ShareSummary } from '../shared/room.ts';

interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<Room>;
  ROOM_LIMIT: RateLimit;
}

interface Credential extends Device {
  id: string;
  tokenHash: string;
  host: boolean;
  issuedAt: number;
  reservedUntil: number;
}
interface RoomState {
  id: string;
  adminHash: string;
  inviteHash: string;
  inviteExpiresAt: number;
  expiresAt: number;
  emptyUntil: number | null;
  members: Credential[];
}
interface Attachment {
  member: Member;
  active: boolean;
  windowStartedAt: number;
  count: number;
  share?: ShareSummary;
}

const encoder = new TextEncoder();
const CLOSED = 4403;
const errorStatus: Record<string, number> = {
  BAD_REQUEST: 400,
  MESSAGE_TOO_LARGE: 413,
  AUTH_REQUIRED: 401,
  ORIGIN_DENIED: 403,
  INVITE_EXPIRED: 403,
  MEMBER_REVOKED: 403,
  ROOM_FULL: 409,
  ROOM_CLOSED: 410,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
};
const noCache = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' };

function fail(code: string): never {
  throw new Error(code);
}

function response(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: noCache });
}

function problem(code: string): Response {
  return response({ code }, errorStatus[code] ?? 500);
}

function secret(length: number): string {
  const value = crypto.getRandomValues(new Uint8Array(length));
  return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(hash), (part) => part.toString(16).padStart(2, '0')).join('');
}

function requireToken(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail('AUTH_REQUIRED');
  return value;
}

function bearer(request: Request): string {
  return requireToken(request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1]);
}

async function json(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader || request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail('BAD_REQUEST');
  const raw = new Uint8Array(2048);
  let used = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (used + value.length > raw.length) {
      void reader.cancel();
      fail('MESSAGE_TOO_LARGE');
    }
    raw.set(value, used);
    used += value.length;
  }
  try {
    return record(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw.subarray(0, used))));
  } catch {
    fail('BAD_REQUEST');
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      if (!roomPage(url.pathname)) return env.ASSETS.fetch(request);
      if (request.method !== 'GET' && request.method !== 'HEAD') return problem('NOT_FOUND');
      const shell = await env.ASSETS.fetch(new URL('/app', url), { method: request.method });
      const headers = new Headers(shell.headers);
      headers.set('Cache-Control', 'private, no-store');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      headers.delete('ETag');
      return new Response(shell.body, { status: shell.status, headers });
    }
    const match = /^\/api\/v1\/rooms(?:\/([^/]+)(?:\/(.*))?)?$/.exec(url.pathname);
    if (!match) return problem('NOT_FOUND');
    const [, roomId, tail] = match;
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return problem('ORIGIN_DENIED');
    try {
      if (!roomId && request.method === 'POST') {
        const device = readDevice(await json(request));
        await limit(env, request, 'create');
        const id = secret(16);
        return response(await env.ROOMS.getByName(id).create(id, device), 201);
      }
      if (!roomId || !ROOM_ID.test(roomId)) return problem('NOT_FOUND');
      const room = env.ROOMS.getByName(roomId);
      if (tail === 'join' && request.method === 'POST') {
        const body = await json(request);
        await limit(env, request, 'join');
        return response(await room.join(readDevice(body), requireToken(body.invite)), 201);
      }
      if (tail === 'socket' && request.method === 'GET') {
        if (origin !== url.origin) fail('ORIGIN_DENIED');
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') fail('BAD_REQUEST');
        const protocols = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map((part) => part.trim());
        requireToken(protocols?.find((part) => part.startsWith('auth.'))?.slice(5));
        const instance = url.searchParams.get('instance');
        if (!protocols?.includes(SOCKET_PROTOCOL) || !isUuid(instance)) fail('BAD_REQUEST');
        await limit(env, request, 'socket');
        return await room.fetch(request);
      }
      if (tail === 'session' && request.method === 'GET') {
        return response(await room.status(bearer(request)));
      }
      if (tail === 'invites/rotate' && request.method === 'POST') {
        return response(await room.rotate(bearer(request)));
      }
      if (tail === 'members/self' && request.method === 'PATCH') {
        const token = bearer(request);
        const name = readDeviceName((await json(request)).name);
        await limit(env, request, 'rename');
        await room.rename(token, name);
        return response({ ok: true });
      }
      if (tail === 'members/self' && request.method === 'DELETE') {
        await room.leave(bearer(request));
        return response({ ok: true });
      }
      const target = tail?.match(/^members\/([^/]+)$/)?.[1];
      if (isUuid(target) && request.method === 'DELETE') {
        await room.kick(bearer(request), target);
        return response({ ok: true });
      }
      if (!tail && request.method === 'DELETE') {
        await room.end(bearer(request));
        return response({ ok: true });
      }
      return problem('NOT_FOUND');
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return problem(Object.hasOwn(errorStatus, code) ? code : 'SERVER_ERROR');
    }
  },
} satisfies ExportedHandler<Env>;

async function limit(env: Env, request: Request, action: string): Promise<void> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (!(await env.ROOM_LIMIT.limit({ key: action + ':' + ip })).success) fail('RATE_LIMITED');
}

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS room (key INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  }

  private load(): RoomState | undefined {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM room WHERE key = 1').toArray()[0];
    return row && JSON.parse(row.data) as RoomState;
  }

  private current(): RoomState {
    const room = this.load();
    if (!room || Date.now() >= Math.min(room.expiresAt, room.emptyUntil ?? Infinity)) fail('ROOM_CLOSED');
    return room;
  }

  private save(room: RoomState): void {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO room (key, data) VALUES (1, ?)', JSON.stringify(room));
  }

  private member(room: RoomState, tokenHash: string): Credential {
    return room.members.find((member) => member.tokenHash === tokenHash) ?? fail('MEMBER_REVOKED');
  }

  private admin(room: RoomState, tokenHash: string): void {
    if (room.adminHash !== tokenHash) fail('AUTH_REQUIRED');
  }

  private sockets(): { socket: WebSocket; info: Attachment }[] {
    return this.ctx.getWebSockets().flatMap((socket) => {
      const info = socket.deserializeAttachment() as Attachment | null;
      return info?.active && socket.readyState === 1 ? [{ socket, info }] : [];
    });
  }

  private send(socket: WebSocket, message: RoomEvent): void {
    try { socket.send(JSON.stringify(message)); } catch { /* The close event updates presence. */ }
  }

  private disconnect(socket: WebSocket, info: Attachment, reason: string): void {
    info.active = false;
    socket.serializeAttachment(info);
    this.send(socket, { type: 'room.closed', code: reason });
    if (socket.readyState === 1) socket.close(CLOSED, reason);
  }

  private snapshot(room: RoomState): void {
    const sockets = this.sockets();
    const members = sockets.map(({ info }) => info.member);
    const shares = sockets.flatMap(({ info }) => info.share && info.share.expiresAt > Date.now() ? [info.share] : []);
    for (const { socket, info } of sockets) {
      this.send(socket, {
        type: 'room.snapshot', members, expiresAt: room.expiresAt,
        shares: shares.filter((share) => !share.to || share.to === info.member.id || share.ownerId === info.member.id),
      });
    }
  }

  private async session(roomId: string, device: Device, host: boolean) {
    const now = Date.now();
    const token = secret(32);
    const peerId = crypto.randomUUID();
    const member: Credential = {
      ...device, id: peerId, tokenHash: await digest(token), host, issuedAt: now, reservedUntil: now + 30_000,
    };
    return { member, session: { roomId, peerId, token } };
  }

  async create(id: string, device: Device): Promise<Session> {
    const { member, session } = await this.session(id, device, true);
    const adminToken = secret(32);
    const inviteSecret = secret(32);
    const [adminHash, inviteHash] = await Promise.all([digest(adminToken), digest(inviteSecret)]);
    if (this.load()) fail('BAD_REQUEST');
    const now = Date.now();
    const inviteExpiresAt = now + INVITE_TTL;
    const expiresAt = now + ROOM_TTL;
    const emptyUntil = now + EMPTY_ROOM_TTL;
    this.save({ id, adminHash, inviteHash, inviteExpiresAt, expiresAt, emptyUntil, members: [member] });
    await this.ctx.storage.setAlarm(emptyUntil);
    return { ...session, adminToken, invite: { secret: inviteSecret, expiresAt: inviteExpiresAt }, roomExpiresAt: expiresAt };
  }

  async join(device: Device, invite: string): Promise<Session> {
    const inviteHash = await digest(invite);
    const candidate = await this.session('', device, false);
    const room = this.current();
    const now = Date.now();
    if (now >= room.inviteExpiresAt || inviteHash !== room.inviteHash) fail('INVITE_EXPIRED');
    const online = new Set(this.sockets().map(({ info }) => info.member.id));
    const occupying = room.members.filter((member) => online.has(member.id) || member.reservedUntil > now);
    if (occupying.length >= ROOM_CAPACITY) fail('ROOM_FULL');
    if (room.members.length >= 96) {
      const removable = room.members.find((member) => !member.host && !occupying.includes(member));
      room.members = room.members.filter((member) => member !== removable);
    }
    room.members.push(candidate.member);
    this.save(room);
    return { ...candidate.session, roomId: room.id, roomExpiresAt: room.expiresAt };
  }

  async status(token: string): Promise<{ expiresAt: number }> {
    const hash = await digest(token);
    const room = this.current();
    this.member(room, hash);
    return { expiresAt: room.expiresAt };
  }

  async fetch(request: Request): Promise<Response> {
    const token = requireToken(request.headers.get('Sec-WebSocket-Protocol')?.split(',')
      .map((part) => part.trim()).find((part) => part.startsWith('auth.'))?.slice(5));
    const instance = new URL(request.url).searchParams.get('instance');
    if (!isUuid(instance)) return problem('BAD_REQUEST');
    const hash = await digest(token);
    let room: RoomState;
    let credential: Credential;
    try {
      room = this.current();
      credential = this.member(room, hash);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'AUTH_REQUIRED';
      return problem(code);
    }

    const sockets = this.sockets();
    const previous = sockets.find(({ info }) => info.member.id === credential.id);
    const online = new Set(sockets.map(({ info }) => info.member.id));
    const now = Date.now();
    const occupied = room.members.filter((member) => member.id !== credential.id &&
      (online.has(member.id) || member.reservedUntil > now));
    if (occupied.length >= ROOM_CAPACITY) return problem('ROOM_FULL');

    if (previous) this.disconnect(previous.socket, previous.info, 'SESSION_REPLACED');
    const { 0: client, 1: server } = new WebSocketPair();
    const member: Member = { id: credential.id, name: credential.name, kind: credential.kind, host: credential.host, instance };
    this.ctx.acceptWebSocket(server, [member.id]);
    const share = previous?.info.member.instance === instance ? previous.info.share : undefined;
    server.serializeAttachment({ member, share, active: true, windowStartedAt: now, count: 0 } satisfies Attachment);
    credential.reservedUntil = 0;
    room.emptyUntil = null;
    this.save(room);
    await this.ctx.storage.setAlarm(room.expiresAt);
    this.snapshot(room);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': SOCKET_PROTOCOL } });
  }

  async rotate(token: string): Promise<Invite> {
    const next = secret(32);
    const [hash, nextHash] = await Promise.all([digest(token), digest(next)]);
    const room = this.current();
    this.admin(room, hash);
    room.inviteHash = nextHash;
    room.inviteExpiresAt = Math.min(Date.now() + INVITE_TTL, room.expiresAt);
    this.save(room);
    return { secret: next, expiresAt: room.inviteExpiresAt };
  }

  async rename(token: string, name: string): Promise<void> {
    const hash = await digest(token);
    const room = this.current();
    const member = this.member(room, hash);
    if (member.name === name) return;
    member.name = name;
    this.save(room);
    for (const { socket, info } of this.sockets()) {
      if (info.member.id !== member.id) continue;
      info.member.name = name;
      socket.serializeAttachment(info);
    }
    this.snapshot(room);
  }

  async leave(token: string): Promise<void> {
    const hash = await digest(token);
    const room = this.current();
    await this.remove(room, this.member(room, hash).id);
  }

  async kick(token: string, target: string): Promise<void> {
    const hash = await digest(token);
    const room = this.current();
    this.admin(room, hash);
    if (!room.members.some((member) => member.id === target && !member.host)) fail('NOT_FOUND');
    await this.remove(room, target);
  }

  private async remove(room: RoomState, peerId: string): Promise<void> {
    room.members = room.members.filter((member) => member.id !== peerId);
    this.save(room);
    for (const { socket, info } of this.sockets()) {
      if (info.member.id === peerId) this.disconnect(socket, info, 'MEMBER_REVOKED');
      else this.send(socket, { type: 'room.revoked', peerId });
    }
    await this.presenceChanged(room);
  }

  async end(token: string): Promise<void> {
    const hash = await digest(token);
    const room = this.current();
    this.admin(room, hash);
    await this.closeRoom();
  }

  private async closeRoom(): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM room');
    for (const { socket, info } of this.sockets()) this.disconnect(socket, info, 'ROOM_CLOSED');
    await this.ctx.storage.deleteAlarm();
  }

  private async presenceChanged(room: RoomState): Promise<void> {
    this.snapshot(room);
    if (this.sockets().length === 0 && room.emptyUntil === null) {
      room.emptyUntil = Math.min(Date.now() + EMPTY_ROOM_TTL, room.expiresAt);
      this.save(room);
      await this.ctx.storage.setAlarm(room.emptyUntil);
    }
  }

  async alarm(): Promise<void> {
    const room = this.load();
    if (!room) return;
    const deadline = Math.min(room.expiresAt, room.emptyUntil ?? Infinity);
    if (Date.now() >= deadline) await this.closeRoom();
    else await this.ctx.storage.setAlarm(deadline);
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    const info = socket.deserializeAttachment() as Attachment | null;
    if (socket.readyState === 2) {
      if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) socket.close(code);
      else socket.close();
    }
    if (!info?.active) return;
    socket.serializeAttachment({ ...info, active: false });
    const room = this.load();
    if (room) await this.presenceChanged(room);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const info = socket.deserializeAttachment() as Attachment | null;
    if (info?.active) this.disconnect(socket, info, 'SIGNAL_DISCONNECTED');
    const room = this.load();
    if (room) await this.presenceChanged(room);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const info = socket.deserializeAttachment() as Attachment | null;
    if (!info?.active) return;
    let to: string | undefined;
    try {
      const room = this.current();
      if (typeof message !== 'string' || message.length > MAX_SIGNAL_BYTES ||
          encoder.encode(message).byteLength > MAX_SIGNAL_BYTES) fail('MESSAGE_TOO_LARGE');
      const now = Date.now();
      if (now - info.windowStartedAt > 10_000) {
        info.windowStartedAt = now;
        info.count = 0;
      }
      if (info.count >= 200) {
        this.disconnect(socket, info, 'RATE_LIMITED');
        void this.presenceChanged(room);
        return;
      }
      info.count++;
      socket.serializeAttachment(info);
      let data: Record<string, unknown>;
      try { data = record(JSON.parse(message)); } catch { fail('BAD_REQUEST'); }
      if (data.v !== VERSION) fail('BAD_REQUEST');
      const sockets = this.sockets();
      if (data.type === 'share.publish') {
        const { shareId, count, size, audience } = data;
        if (!isUuid(shareId) || typeof count !== 'number' || !Number.isInteger(count) ||
            count < 1 || count > MAX_BATCH_FILES || (audience !== null && (!isUuid(audience) || audience === info.member.id))) {
          fail('BAD_REQUEST');
        }
        if (audience && !sockets.some(({ info: target }) => target.member.id === audience)) fail('PEER_OFFLINE');
        info.share = {
          id: shareId, ownerId: info.member.id, to: audience ?? undefined, count,
          size: String(bytes(size)), expiresAt: Math.min(now + INVITE_TTL, room.expiresAt),
        };
        socket.serializeAttachment(info);
        this.snapshot(room);
        return;
      }
      if (data.type === 'share.remove') {
        delete info.share;
        socket.serializeAttachment(info);
        this.snapshot(room);
        return;
      }
      if (data.type === 'share.request') {
        const owner = sockets.find(({ info: candidate }) => {
          const share = candidate.share;
          return share && candidate.member.id !== info.member.id && share.id === data.shareId &&
            share.expiresAt > now && (!share.to || share.to === info.member.id);
        });
        if (!owner?.info.share) fail('PEER_OFFLINE');
        this.send(owner.socket, { type: 'share.request', shareId: owner.info.share.id, from: info.member.id });
        return;
      }
      const signal = readSignal(data, room.id, info.member.id);
      to = signal.to;
      const target = sockets.find(({ info: candidate }) => candidate.member.id === signal.to &&
        candidate.member.instance === signal.to_instance);
      if (!target) fail('PEER_OFFLINE');
      this.send(target.socket, { ...signal, from: info.member.id, from_instance: info.member.instance });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      this.send(socket, { type: 'error', code: code === 'ROOM_CLOSED' ? code :
        ['BAD_REQUEST', 'MESSAGE_TOO_LARGE', 'RELAY_NOT_ALLOWED', 'PEER_OFFLINE'].includes(code) ? code : 'BAD_REQUEST', peerId: to });
    }
  }
}
