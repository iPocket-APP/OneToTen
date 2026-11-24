import { sha256 } from '@noble/hashes/sha2.js';
import { bytes } from '../shared/room.ts';
import { CHECKPOINT, INDEXED_DB_LIMIT, IO_BLOCK, MEMORY_LIMIT, OPFS_LIMIT } from './protocol.ts';
import { addRecord, deleteStored, discardPartial, indexedChunks, probeIndexedStorage, putIndexedCheckpoint, putRecord, records,
  storageDirectory } from './storage-model.ts';
import type { ReceiveStart, ReceiveWrite, SavedRecord, StorageProbe, WorkerAnswer, WorkerCommand } from './storage-model.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
type Hasher = ReturnType<typeof sha256.create>;
type SyncFile = FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<FileSystemSyncAccessHandle> };
type Writer =
  | { mode: 'direct'; stream: FileSystemWritableFileStream }
  | { mode: 'opfs-stream'; stream: FileSystemWritableFileStream }
  | { mode: 'opfs-sync'; sync: FileSystemSyncAccessHandle }
  | { mode: 'indexed-db'; parts: ArrayBuffer[] }
  | { mode: 'memory'; parts: ArrayBuffer[] };

let sending: { file: File; hash: Hasher; offset: number; digest?: string } | undefined;
let receiving: { entry: SavedRecord; writer: Writer; hash: Hasher; written: number; closed: boolean } | undefined;
let queue = Promise.resolve();

function hex(value: Uint8Array): string {
  return Array.from(value, (part) => part.toString(16).padStart(2, '0')).join('');
}

function prefix(hash: Hasher): string {
  return hex(hash.clone().digest());
}

function errorCode(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'QUOTA_EXCEEDED';
  if (error instanceof Error && /^[A-Z_]{1,40}$/.test(error.message)) return error.message;
  return sending ? 'FILE_CHANGED' : 'STORAGE_UNAVAILABLE';
}

async function probe(): Promise<StorageProbe> {
  if (!isSecureContext) {
    const available = await probeIndexedStorage().catch(() => false);
    return { staging: available ? 'indexed-db' : null };
  }
  let directory: FileSystemDirectoryHandle | undefined;
  const test = crypto.randomUUID();
  try {
    await records();
    directory = await storageDirectory();
    const file: SyncFile = await directory.getFileHandle(test, { create: true });
    if (typeof file.createSyncAccessHandle === 'function') {
      try {
        const handle = await file.createSyncAccessHandle();
        handle.close();
        return { staging: 'opfs-sync' };
      } catch { /* Check the asynchronous writer. */ }
    }
    const stream = await file.createWritable();
    await stream.abort();
    return { staging: 'opfs-stream' };
  } catch {
    return { staging: null };
  } finally {
    await directory?.removeEntry(test).catch(() => undefined);
  }
}

async function release(preserve: boolean): Promise<void> {
  const state = receiving;
  sending = undefined;
  receiving = undefined;
  if (!state || state.closed) return;
  const { writer, entry } = state;
  if (writer.mode === 'opfs-sync') writer.sync.close();
  if (writer.mode === 'direct' || writer.mode === 'opfs-stream') await writer.stream.abort().catch(() => undefined);
  if (writer.mode === 'indexed-db' && !preserve) await discardPartial(entry.id, entry.checkpoint);
  if (writer.mode === 'opfs-stream' || (writer.mode === 'opfs-sync' && !preserve)) await deleteStored(entry.id);
}

async function checkQuota(needed: number): Promise<void> {
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < needed) {
    throw new Error('QUOTA_EXCEEDED');
  }
}

async function prepare(command: Extract<WorkerCommand, { type: 'receive.start' }>): Promise<ReceiveStart> {
  const entry = { ...command.entry };
  const size = bytes(entry.file.size_bytes);
  const offset = command.resume ? entry.checkpoint : 0;
  const hash = sha256.create();
  let writer: Writer;
  if (command.choice === 'direct' && command.handle && !command.resume) {
    writer = { mode: 'direct', stream: await command.handle.createWritable() };
  } else if (command.choice === 'memory' && !command.resume) {
    if (size > MEMORY_LIMIT) throw new Error('FILE_TOO_LARGE');
    writer = { mode: 'memory', parts: [] };
  } else if (command.choice === 'indexed-db') {
    if (size > INDEXED_DB_LIMIT) throw new Error('FILE_TOO_LARGE');
    await checkQuota(size - offset + 8 * IO_BLOCK);
    if (command.resume) {
      if (entry.mode !== 'indexed-db' || offset < 0 || offset > size || offset % CHECKPOINT ||
          (offset > 0 && !entry.prefix)) throw new Error('CHECKPOINT_MISMATCH');
      for await (const chunk of indexedChunks(entry.id, offset)) hash.update(new Uint8Array(await chunk.arrayBuffer()));
      if (offset && prefix(hash) !== entry.prefix) throw new Error('CHECKPOINT_MISMATCH');
    } else {
      entry.mode = 'indexed-db';
      await addRecord(entry);
    }
    writer = { mode: 'indexed-db', parts: [] };
  } else if (command.choice === 'opfs') {
    if (size > OPFS_LIMIT) throw new Error('FILE_TOO_LARGE');
    await checkQuota(size - offset + size + 8 * IO_BLOCK);
    const directory = await storageDirectory();
    const handle: SyncFile = await directory.getFileHandle(entry.id, { create: !command.resume });
    try {
      let sync: FileSystemSyncAccessHandle | undefined;
      if (typeof handle.createSyncAccessHandle === 'function') {
        try { sync = await handle.createSyncAccessHandle(); } catch (error) {
          if (command.resume) throw error;
        }
      }
      if (sync) writer = { mode: 'opfs-sync', sync };
      else if (command.resume) throw new Error('CHECKPOINT_MISMATCH');
      else writer = { mode: 'opfs-stream', stream: await handle.createWritable() };
      receiving = { entry, writer, hash, written: offset, closed: false };
      if (writer.mode === 'opfs-sync') {
        if (command.resume) {
          if (offset > size || writer.sync.getSize() < offset) throw new Error('CHECKPOINT_MISMATCH');
          for (let position = 0; position < offset;) {
            const chunk = new Uint8Array(Math.min(IO_BLOCK, offset - position));
            const read = writer.sync.read(chunk, { at: position });
            if (read !== chunk.byteLength) throw new Error('CHECKPOINT_MISMATCH');
            hash.update(chunk);
            position += read;
          }
          if (offset && prefix(hash) !== entry.prefix) throw new Error('CHECKPOINT_MISMATCH');
        }
        writer.sync.truncate(offset);
        writer.sync.flush();
      }
      entry.mode = writer.mode;
      entry.updatedAt = Date.now();
      await putRecord(entry);
    } catch (error) {
      if (receiving) await release(command.resume).catch(() => undefined);
      else if (!command.resume) await deleteStored(entry.id).catch(() => undefined);
      throw error;
    }
  } else {
    throw new Error('STORAGE_UNAVAILABLE');
  }
  receiving = { entry, writer, hash, written: offset, closed: false };
  return { mode: writer.mode, offset, prefix: offset ? entry.prefix : null };
}

async function write(block: ArrayBuffer): Promise<ReceiveWrite> {
  const state = receiving;
  if (!state || state.closed || state.written + block.byteLength > Number(state.entry.file.size_bytes)) {
    throw new Error('INVALID_FRAME');
  }
  const { writer, hash, entry } = state;
  const content = new Uint8Array(block);
  let result: ReceiveWrite = { written: state.written };
  for (let at = 0; at < content.byteLength;) {
    const length = Math.min(content.byteLength - at, CHECKPOINT - state.written % CHECKPOINT);
    const part = content.subarray(at, at + length);
    if (writer.mode === 'opfs-sync') {
      for (let written = 0; written < length;) {
        const count = writer.sync.write(part.subarray(written), { at: state.written + written });
        if (count <= 0) throw new Error('STORAGE_UNAVAILABLE');
        written += count;
      }
    } else if (writer.mode === 'memory' || writer.mode === 'indexed-db') {
      writer.parts.push(at === 0 && length === block.byteLength ? block : block.slice(at, at + length));
    } else {
      await writer.stream.write(part);
    }
    hash.update(part);
    at += length;
    state.written += length;
    result.written = state.written;
    if ((writer.mode === 'opfs-sync' || writer.mode === 'indexed-db') && state.written % CHECKPOINT === 0) {
      const next = { ...entry, checkpoint: state.written, prefix: prefix(hash), updatedAt: Date.now() };
      if (writer.mode === 'opfs-sync') {
        writer.sync.flush();
        await putRecord(next);
      } else {
        await putIndexedCheckpoint(next, entry.checkpoint, new Blob(writer.parts));
        writer.parts = [];
      }
      Object.assign(entry, next);
      result = { written: state.written, checkpoint: next.checkpoint, prefix: next.prefix };
    }
  }
  return result;
}

async function commit(expected: string): Promise<{ entry?: SavedRecord; file?: File }> {
  const state = receiving;
  if (!state || state.written !== Number(state.entry.file.size_bytes)) throw new Error('INVALID_FRAME');
  const { writer, entry } = state;
  if (hex(state.hash.digest()) !== expected) throw new Error('HASH_MISMATCH');
  if (writer.mode === 'indexed-db') {
    const completed = { ...entry, digest: expected, checkpoint: state.written, updatedAt: Date.now() };
    const tail = writer.parts.length ? new Blob(writer.parts) : undefined;
    await putIndexedCheckpoint(completed, entry.checkpoint, tail);
    state.closed = true;
    return { entry: completed };
  }
  if (writer.mode === 'opfs-sync') {
    writer.sync.flush();
    writer.sync.close();
  } else if (writer.mode === 'direct' || writer.mode === 'opfs-stream') {
    await writer.stream.close();
  }
  state.closed = true;
  if (writer.mode === 'opfs-sync' || writer.mode === 'opfs-stream') {
    entry.digest = expected;
    entry.checkpoint = state.written;
    entry.updatedAt = Date.now();
    await putRecord(entry);
    return { entry };
  }
  if (writer.mode === 'memory') {
    return { file: new File(writer.parts, entry.file.name, { type: 'application/octet-stream' }) };
  }
  return {};
}

async function execute(command: WorkerCommand): Promise<unknown> {
  switch (command.type) {
    case 'probe': return probe();
    case 'send.start': {
      const hash = sha256.create();
      const { file, offset } = command;
      sending = { hash, file, offset };
      if (offset > file.size) throw new Error('CHECKPOINT_MISMATCH');
      for (let position = 0; position < offset;) {
        const length = Math.min(IO_BLOCK, offset - position);
        const block = await file.slice(position, position + length).arrayBuffer();
        if (block.byteLength !== length) throw new Error('FILE_CHANGED');
        hash.update(new Uint8Array(block));
        position += length;
      }
      if (offset && prefix(hash) !== command.prefix) throw new Error('CHECKPOINT_MISMATCH');
      return;
    }
    case 'send.read': {
      const state = sending;
      if (!state || command.size < 1 || command.size > IO_BLOCK) throw new Error('FILE_CHANGED');
      const block = await state.file.slice(state.offset, state.offset + command.size).arrayBuffer();
      if (block.byteLength !== command.size) throw new Error('FILE_CHANGED');
      state.hash.update(new Uint8Array(block));
      state.offset += block.byteLength;
      return block;
    }
    case 'send.digest':
      if (!sending || sending.offset !== sending.file.size) throw new Error('FILE_CHANGED');
      sending.digest ??= hex(sending.hash.digest());
      return sending.digest;
    case 'receive.start': return prepare(command);
    case 'receive.write': return write(command.block);
    case 'receive.commit': return commit(command.digest);
    case 'release': return release(command.preserve);
  }
}

scope.onmessage = (event: MessageEvent<WorkerCommand & { id: number }>) => {
  const command = event.data;
  queue = queue.then(async () => {
    try {
      const value = await execute(command);
      scope.postMessage({ id: command.id, value } satisfies WorkerAnswer, value instanceof ArrayBuffer ? [value] : []);
    } catch (error) {
      scope.postMessage({ id: command.id, error: errorCode(error) } satisfies WorkerAnswer);
    }
  });
};

