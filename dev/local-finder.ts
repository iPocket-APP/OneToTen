import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';
import { INDEXED_DB_LIMIT, safeFilename } from '../src/browser/protocol.ts';
import { bytes, isUuid } from '../src/shared/room.ts';

const route = '/__file-room/finder';
const runFile = promisify(execFile);

interface FinderOptions {
  directory: string;
  reveal: (path: string) => Promise<void>;
  quarantine?: (path: string) => Promise<void>;
}

interface SavedFile { path: string; device: bigint; inode: bigint }

function reply(response: ServerResponse, status: number, body: object): void {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function localOrigin(request: IncomingMessage): string | undefined {
  const { localAddress, remoteAddress, localPort } = request.socket;
  if (!localAddress || localAddress !== remoteAddress || !localPort) return;
  if (request.headers.forwarded || request.headers['x-forwarded-for']) return;
  const ip = localAddress.replace(/^::ffff:/, '');
  const address = ip.includes(':') ? '[' + ip + ']' : ip;
  const host = request.headers.host;
  const authority = address + ':' + localPort;
  const loopback = ip.startsWith('127.') || ip === '::1';
  if (host !== authority && !(loopback && host === 'localhost:' + localPort)) return;
  const scheme = (request.socket as TLSSocket).encrypted ? 'https://' : 'http://';
  try { return new URL(scheme + host).origin; } catch { return undefined; }
}

function metadata(request: IncomingMessage): { name: string; size: number; digest?: string } {
  const encoded = request.headers['x-file-room-name'];
  const digest = request.headers['x-file-room-sha256'];
  const size = bytes(request.headers['x-file-room-size']);
  if (typeof encoded !== 'string' || !encoded || size > INDEXED_DB_LIMIT ||
      (digest !== undefined && (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))) ||
      (request.headers['content-length'] !== undefined && request.headers['content-length'] !== String(size))) {
    throw new Error('BAD_REQUEST');
  }
  const name = safeFilename(decodeURIComponent(encoded));
  const extension = extname(name);
  const suffix = Buffer.byteLength(extension) <= 32 ? extension : '';
  let stem = '';
  for (const character of basename(name, suffix)) {
    if (Buffer.byteLength(stem + character + suffix) > 230) break;
    stem += character;
  }
  return { name: (stem || 'file') + suffix, size, digest };
}

async function saveFile(request: IncomingMessage, directory: string, file: ReturnType<typeof metadata>,
  quarantine: FinderOptions['quarantine']): Promise<SavedFile> {
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, '.file-room-'));
  const temporary = join(staging, 'incoming');
  try {
    const hash = file.digest ? createHash('sha256') : undefined;
    let received = 0;
    const check = new Transform({
      transform(chunk: Buffer, _, done) {
        received += chunk.byteLength;
        if (received > file.size) return done(new Error('BAD_REQUEST'));
        hash?.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(request, check, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (received !== file.size || (hash && hash.digest('hex') !== file.digest)) throw new Error('HASH_MISMATCH');
    await quarantine?.(temporary);

    const { dev, ino } = await lstat(temporary, { bigint: true });
    const extension = extname(file.name);
    const stem = basename(file.name, extension);
    for (let index = 0; index < 1000; index++) {
      const path = join(directory, index ? stem + ' (' + index + ')' + extension : file.name);
      try {
        await link(temporary, path);
        return { path, device: dev, inode: ino };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('SAVE_UNAVAILABLE');
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function finderMiddleware(options: FinderOptions) {
  const directory = resolve(options.directory);
  const savedFiles = new Map<string, SavedFile>();
  const writing = new Set<string>();

  return async (request: IncomingMessage, response: ServerResponse, next: () => void): Promise<void> => {
    const path = request.url?.split('?')[0] ?? '';
    if (path !== route && !path.startsWith(route + '/')) {
      next();
      return;
    }
    const origin = localOrigin(request);
    if (!origin || request.headers['x-file-room-action'] !== 'finder' ||
        (request.method !== 'GET' && request.headers.origin !== origin)) {
      reply(response, 404, { code: 'FINDER_UNAVAILABLE' });
      return;
    }
    if (path === route && request.method === 'GET') {
      reply(response, 200, { available: true });
      return;
    }
    const id = path.slice(route.length + 1);
    if (!isUuid(id) || (request.method !== 'POST' && request.method !== 'PUT')) {
      reply(response, 404, { code: 'FINDER_UNAVAILABLE' });
      return;
    }
    if (writing.has(id)) {
      reply(response, 409, { code: 'SAVE_IN_PROGRESS' });
      return;
    }
    writing.add(id);
    try {
      let file = savedFiles.get(id);
      if (file) {
        const existing = await lstat(file.path, { bigint: true }).catch(() => undefined);
        if (!existing?.isFile() || existing.dev !== file.device || existing.ino !== file.inode) {
          savedFiles.delete(id);
          file = undefined;
        }
      }
      if (!file && request.method === 'POST') {
        reply(response, 404, { code: 'FILE_NOT_EXPORTED' });
        return;
      }
      if (!file) {
        file = await saveFile(request, directory, metadata(request), options.quarantine);
        savedFiles.set(id, file);
      }
      const revealed = await options.reveal(file.path).then(() => true, () => false);
      reply(response, 200, { name: basename(file.path), revealed });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const diskCode = (error as NodeJS.ErrnoException).code;
      if (code === 'BAD_REQUEST' || error instanceof URIError) reply(response, 400, { code: 'BAD_REQUEST' });
      else if (code === 'HASH_MISMATCH') reply(response, 422, { code });
      else reply(response, 500, { code: diskCode === 'ENOSPC' ? 'QUOTA_EXCEEDED' : 'SAVE_UNAVAILABLE' });
    } finally {
      writing.delete(id);
    }
  };
}

export function localFinder(): Plugin {
  return {
    name: 'file-room-local-finder',
    enforce: 'pre',
    configureServer(server) {
      const handle = finderMiddleware({
        directory: join(homedir(), 'Downloads'),
        async reveal(path) { await runFile('/usr/bin/open', ['-R', path], { timeout: 10_000 }); },
        async quarantine(path) {
          const time = Math.floor(Date.now() / 1000).toString(16);
          const flags = '0081;' + time + ';File Room;';
          await runFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', flags, path], { timeout: 10_000 });
        },
      });
      server.middlewares.use((request, response, next) => { void handle(request, response, next); });
    },
  };
}

