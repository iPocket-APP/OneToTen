import { bytes, randomId } from '../shared/room.ts';
import { CHECKPOINT } from './protocol.ts';
import type { FileInfo, FileSource, SaveChoice, SaveMode, StagingMode } from './protocol.ts';

export interface SavedRecord {
  id: string;
  roomId: string;
  receiver: string;
  sender: string;
  senderName: string;
  file: FileInfo;
  checkpoint: number;
  prefix: string | null;
  digest: string | null;
  updatedAt: number;
  expiresAt?: number;
  mode: StagingMode;
}

export type WorkerCommand<Source extends FileSource = File> =
  | { type: 'probe' }
  | { type: 'send.start'; file: Source; offset: number; prefix: string | null }
  | { type: 'send.read'; size: number }
  | { type: 'send.digest' }
  | { type: 'receive.start'; choice: SaveChoice; entry: SavedRecord; resume: boolean; handle?: FileSystemFileHandle }
  | { type: 'receive.write'; block: ArrayBuffer }
  | { type: 'receive.commit'; digest: string }
  | { type: 'release'; preserve: boolean };

export type WorkerAnswer = { id: number; value: unknown } | { id: number; error: string };
export interface StorageProbe { staging: StagingMode | null }
export interface ReceiveStart { mode: SaveMode; offset: number; prefix: string | null }
export interface ReceiveWrite { written: number; checkpoint?: number; prefix?: string }
export interface ReceiveResult { entry?: SavedRecord; file?: File; path?: string }

export interface TransferStorage<Source extends FileSource> {
  pipeline: () => {
    call<T>(command: WorkerCommand<Source>, buffers?: Transferable[]): Promise<T>;
    release(preserve: boolean): Promise<void>;
  };
  records: () => Promise<SavedRecord[]>;
  openStored: (entry: SavedRecord) => Promise<unknown>;
  discardPartial: (id: string) => Promise<void>;
  chooseFile?: (name: string) => Promise<FileSystemFileHandle>;
}

let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(isSecureContext ? 'file-room-v1' : 'file-room-http-v1', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('files', { keyPath: 'id' });
      if (!isSecureContext) req.result.createObjectStore('chunks');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('STORAGE_UNAVAILABLE'));
  }).catch((error: unknown) => {
    database = undefined;
    throw error;
  });
  return database;
}

async function transaction<T>(mode: IDBTransactionMode, callback: (store: IDBObjectStore) => IDBRequest<T>, store = 'files'): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = callback(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onabort = () => reject(tx.error ?? new Error('STORAGE_UNAVAILABLE'));
  });
}

export const records = () => transaction<SavedRecord[]>('readonly', (store) => store.getAll());
export const putRecord = (entry: SavedRecord) => transaction('readwrite', (store) => store.put(entry));
export const addRecord = (entry: SavedRecord) => transaction('readwrite', (store) => store.add(entry));
const forget = (id: string) => transaction('readwrite', (store) => store.delete(id));

export async function probeIndexedStorage(): Promise<boolean> {
  const key = [randomId(), 0];
  try {
    const bytes = new Uint8Array(CHECKPOINT);
    bytes[0] = 1;
    await transaction('readwrite', (store) => store.add(new Blob([bytes]), key), 'chunks');
    const chunk: Blob = await transaction('readonly', (store) => store.get(key), 'chunks');
    return chunk?.size === bytes.length && new Uint8Array(await chunk.slice(0, 1).arrayBuffer())[0] === 1;
  } finally {
    await transaction('readwrite', (store) => store.delete(key), 'chunks').catch(() => undefined);
  }
}

export async function putIndexedCheckpoint(entry: SavedRecord, offset: number, chunk?: Blob): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['files', 'chunks'], 'readwrite', { durability: 'strict' });
    const files = tx.objectStore('files');
    const current = files.get(entry.id);
    let stale = false;
    current.onsuccess = () => {
      const previous = current.result as SavedRecord | undefined;
      if (previous?.mode !== 'indexed-db' || previous.digest !== null || previous.checkpoint !== offset ||
          (chunk?.size ?? 0) !== entry.checkpoint - offset) {
        stale = true;
        tx.abort();
        return;
      }
      if (chunk) tx.objectStore('chunks').add(chunk, [entry.id, offset]);
      files.put(entry);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(stale ? new Error('CHECKPOINT_MISMATCH') : tx.error ?? new Error('STORAGE_UNAVAILABLE'));
  });
}

export async function* indexedChunks(id: string, through: number): AsyncGenerator<Blob> {
  const batch = 32 * CHECKPOINT;
  for (let offset = 0; offset < through; offset += batch) {
    const end = Math.min(through, offset + batch);
    const range = IDBKeyRange.bound([id, offset], [id, end], false, true);
    const chunks = await transaction<Blob[]>('readonly', (store) => store.getAll(range), 'chunks');
    let cursor = offset;
    for (const chunk of chunks) {
      const size = Math.min(CHECKPOINT, end - cursor);
      if (!(chunk instanceof Blob) || !size || chunk.size !== size) throw new Error('CHECKPOINT_MISMATCH');
      cursor += size;
      yield chunk;
    }
    if (cursor !== end) throw new Error('CHECKPOINT_MISMATCH');
  }
}

async function deleteIndexed(id: string, when?: (entry: SavedRecord) => boolean): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['files', 'chunks'], 'readwrite');
    const files = tx.objectStore('files');
    const remove = () => {
      tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      files.delete(id);
    };
    if (!when) remove();
    else {
      const req = files.get(id);
      req.onsuccess = () => {
        const entry = req.result as SavedRecord | undefined;
        if (entry && when(entry)) remove();
      };
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('STORAGE_UNAVAILABLE'));
  });
}

export async function pruneExpiredStaging(): Promise<void> {
  if (isSecureContext) return;
  const now = Date.now();
  for (const entry of await records()) {
    if (entry.digest === null && (entry.expiresAt ?? Infinity) <= now) {
      await deleteIndexed(entry.id, (current) => current.digest === null && (current.expiresAt ?? Infinity) <= now);
    }
  }
}

export async function discardPartial(id: string, checkpoint?: number): Promise<void> {
  if (!isSecureContext) {
    return deleteIndexed(id, (entry) => entry.digest === null && (checkpoint === undefined || entry.checkpoint === checkpoint));
  }
  const entry = await transaction<SavedRecord | undefined>('readonly', (store) => store.get(id));
  if (!entry?.digest) await deleteStored(id);
}

export async function storageDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('file-room-v1', { create: true });
}

export async function openStored(entry: SavedRecord): Promise<File> {
  if (!entry.digest) throw new Error('EXPORT_UNAVAILABLE');
  if (entry.mode === 'indexed-db') {
    const chunks: Blob[] = [];
    for await (const chunk of indexedChunks(entry.id, bytes(entry.file.size_bytes))) chunks.push(chunk);
    return new File(chunks, entry.file.name, { type: 'application/octet-stream' });
  }
  const directory = await storageDirectory();
  const file = await (await directory.getFileHandle(entry.id)).getFile();
  if (file.size !== Number(entry.file.size_bytes)) throw new Error('EXPORT_UNAVAILABLE');
  return file;
}

export async function deleteStored(id: string): Promise<void> {
  if (!isSecureContext) return deleteIndexed(id);
  const directory = await storageDirectory();
  await directory.removeEntry(id).catch((error: DOMException) => {
    if (error.name !== 'NotFoundError') throw error;
  });
  await forget(id);
}

