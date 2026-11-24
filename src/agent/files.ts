import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { IO_BLOCK, safeFilename } from '../browser/protocol.ts';
import type { FileInfo, FileSource } from '../browser/protocol.ts';
import type { ReceiveResult, ReceiveStart, ReceiveWrite, TransferStorage, WorkerCommand } from '../browser/storage-model.ts';

export const MAX_FILE_BYTES = 4 * 1024 ** 3;

export interface DiskSource extends FileSource {
  path: string;
  root?: string;
  identity: BigIntStats;
}

function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest);
}

export async function localDirectory(path: string, create = false): Promise<string> {
  try {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const directory = await realpath(path);
    if ((await stat(directory)).isDirectory()) return directory;
  } catch { /* Report a stable error to the calling client. */ }
  throw new Error(create ? 'INBOX_UNAVAILABLE' : 'SEND_DIRECTORY_UNAVAILABLE');
}

export async function diskSource(path: string, root?: string): Promise<DiskSource> {
  const requested = resolve(root ?? process.cwd(), path);
  if (root && !inside(root, requested)) throw new Error('PATH_OUTSIDE_SEND_DIRECTORY');
  let canonical: string;
  let identity: BigIntStats;
  try {
    canonical = await realpath(requested);
    identity = await lstat(canonical, { bigint: true });
  } catch { throw new Error('FILE_UNAVAILABLE'); }
  if (root && !inside(root, canonical)) throw new Error('PATH_OUTSIDE_SEND_DIRECTORY');
  if (!identity.isFile()) throw new Error('FILE_UNAVAILABLE');
  if (identity.size > BigInt(MAX_FILE_BYTES)) throw new Error('FILE_TOO_LARGE');
  return {
    path: canonical, root, identity, size: Number(identity.size), name: basename(requested),
    type: 'application/octet-stream', lastModified: Number(identity.mtimeMs),
  };
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function openSource(source: DiskSource): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    if (await realpath(source.path) !== source.path) throw new Error('FILE_CHANGED');
    handle = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const canonical = await realpath(source.path);
    if (canonical !== source.path || (source.root && !inside(source.root, canonical)) ||
        !sameFile(source.identity, await lstat(canonical, { bigint: true })) ||
        !sameFile(source.identity, await handle.stat({ bigint: true }))) throw new Error('FILE_CHANGED');
    return handle;
  } catch {
    await handle?.close().catch(() => undefined);
    throw new Error('FILE_CHANGED');
  }
}

function diskFilename(name: string): string {
  const cleaned = safeFilename(name);
  const extension = extname(cleaned);
  const suffix = Buffer.byteLength(extension) <= 32 ? extension : '';
  let stem = '';
  for (const character of basename(cleaned, suffix)) {
    if (Buffer.byteLength(stem + character + suffix) > 230) break;
    stem += character;
  }
  // Reserved Windows device names are invalid even with an extension.
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem)) stem = '_' + stem;
  return (stem || 'file') + suffix;
}

async function publish(temporary: string, directory: string, name: string): Promise<string> {
  const extension = extname(name);
  const stem = basename(name, extension);
  for (let index = 0; index < 1000; index++) {
    const path = join(directory, index ? stem + ' (' + index + ')' + extension : name);
    try {
      await link(temporary, path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('SAVE_UNAVAILABLE');
}

class DiskPipeline {
  private readonly hash = createHash('sha256');
  private handle?: FileHandle;
  private source?: DiskSource;
  private sink?: { directory: string; temporary: string; name: string; size: number };
  private staging?: string;
  private offset = 0;
  private queue = Promise.resolve();
  private closing?: Promise<void>;
  private resolveFinished!: () => void;
  readonly finished = new Promise<void>((resolve) => { this.resolveFinished = resolve; });

  constructor(private readonly inbox: string) {}

  call<T>(command: WorkerCommand<DiskSource>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('STORAGE_UNAVAILABLE'));
    const result = this.queue.then(() => this.run(command));
    this.queue = result.then(() => undefined, () => undefined);
    return result as Promise<T>;
  }

  release(): Promise<void> {
    this.closing ??= this.queue.then(async () => {
      try { await this.handle?.close(); }
      finally { await this.clearStaging(); }
    }).finally(this.resolveFinished);
    return this.closing;
  }

  private async clearStaging(): Promise<void> {
    if (!this.staging) return;
    await rm(this.staging, { recursive: true, force: true });
    this.staging = undefined;
  }

  private async run(command: WorkerCommand<DiskSource>): Promise<unknown> {
    switch (command.type) {
      case 'send.start':
        this.source = command.file;
        this.handle = await openSource(command.file);
        while (this.offset < command.offset) await this.read(Math.min(IO_BLOCK, command.offset - this.offset));
        if (command.prefix !== null && this.hash.copy().digest('hex') !== command.prefix) {
          throw new Error('CHECKPOINT_MISMATCH');
        }
        return;
      case 'send.read':
        return this.read(command.size);
      case 'send.digest':
        if (!this.handle || !this.source || this.offset !== this.source.size ||
            !sameFile(this.source.identity, await this.handle.stat({ bigint: true }))) throw new Error('FILE_CHANGED');
        return this.hash.digest('hex');
      case 'receive.start':
        if (command.choice !== 'direct' || command.resume) throw new Error('CHECKPOINT_MISMATCH');
        return this.startReceive(command.entry.file);
      case 'receive.write':
        return this.write(command.block);
      case 'receive.commit':
        return this.commit(command.digest);
      default:
        throw new Error('STORAGE_UNAVAILABLE');
    }
  }

  private async read(size: number): Promise<ArrayBuffer> {
    if (!this.handle || !this.source || this.offset + size > this.source.size) throw new Error('FILE_CHANGED');
    const data = new Uint8Array(size);
    for (let used = 0; used < size;) {
      const { bytesRead } = await this.handle.read(data, used, size - used, this.offset + used);
      if (!bytesRead) throw new Error('FILE_CHANGED');
      used += bytesRead;
    }
    this.hash.update(data);
    this.offset += size;
    return data.buffer;
  }

  private async startReceive(file: FileInfo): Promise<ReceiveStart> {
    const size = Number(file.size_bytes);
    if (size > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE');
    try {
      const directory = await localDirectory(this.inbox, true);
      this.staging = await mkdtemp(join(directory, '.file-room-'));
      const temporary = join(this.staging, 'incoming');
      this.handle = await open(temporary, 'wx', 0o600);
      this.sink = { directory, temporary, name: diskFilename(file.name), size };
      return { mode: 'direct', offset: 0, prefix: null };
    } catch (error) { throw saveError(error); }
  }

  private async write(block: ArrayBuffer): Promise<ReceiveWrite> {
    if (!this.handle || !this.sink || this.offset + block.byteLength > this.sink.size) throw new Error('INVALID_FRAME');
    const data = new Uint8Array(block);
    try {
      for (let used = 0; used < data.length;) {
        const { bytesWritten } = await this.handle.write(data, used, data.length - used, this.offset + used);
        if (!bytesWritten) throw new Error('SAVE_UNAVAILABLE');
        used += bytesWritten;
      }
    } catch (error) { throw saveError(error); }
    this.hash.update(data);
    this.offset += data.length;
    return { written: this.offset };
  }

  private async commit(digest: string): Promise<ReceiveResult> {
    const { handle, sink } = this;
    if (!handle || !sink || this.offset !== sink.size || this.hash.digest('hex') !== digest) {
      throw new Error('HASH_MISMATCH');
    }
    try {
      await handle.sync();
      await handle.close();
      this.handle = undefined;
      const path = await publish(sink.temporary, sink.directory, sink.name);
      await this.clearStaging().catch(() => undefined);
      return { path };
    } catch (error) { throw saveError(error); }
  }
}

function saveError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  return new Error(code === 'ENOSPC' || code === 'EDQUOT' ? 'QUOTA_EXCEEDED' : 'SAVE_UNAVAILABLE');
}

export class DiskStorage implements TransferStorage<DiskSource> {
  private readonly active = new Set<Promise<void>>();

  constructor(private readonly inbox: string) {}

  pipeline = (): DiskPipeline => {
    const pipeline = new DiskPipeline(this.inbox);
    this.active.add(pipeline.finished);
    void pipeline.finished.then(() => this.active.delete(pipeline.finished));
    return pipeline;
  };

  async records(): Promise<[]> { return []; }
  async openStored(): Promise<never> { throw new Error('EXPORT_UNAVAILABLE'); }
  async discardPartial(): Promise<void> { /* release removes the temporary file. */ }

  async drained(): Promise<void> { await Promise.all(this.active); }
}
