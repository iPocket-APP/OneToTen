import { discardPartial, openStored, records } from './storage-model.ts';
import type { StorageProbe, TransferStorage, WorkerAnswer, WorkerCommand } from './storage-model.ts';

interface SavePicker {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
}

export function hasSavePicker(): boolean {
  return typeof (window as SavePicker).showSaveFilePicker === 'function';
}

export function chooseFile(suggestedName: string): Promise<FileSystemFileHandle> {
  const picker = (window as SavePicker).showSaveFilePicker;
  if (!picker) return Promise.reject(new Error('STORAGE_UNAVAILABLE'));
  return picker.call(window, { suggestedName });
}

export class FilePipeline {
  private readonly worker = new Worker(new URL('./file-worker.ts', import.meta.url), { type: 'module' });
  private readonly requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private closed = false;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerAnswer>) => {
      const answer = event.data;
      const request = this.requests.get(answer.id);
      if (!request) return;
      this.requests.delete(answer.id);
      if ('error' in answer) request.reject(new Error(answer.error));
      else request.resolve(answer.value);
    };
    this.worker.onerror = () => this.terminate();
  }

  call<T>(command: WorkerCommand, buffers: Transferable[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new Error('STORAGE_UNAVAILABLE'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.requests.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({ ...command, id }, buffers);
      } catch {
        this.requests.delete(id);
        reject(new Error('STORAGE_UNAVAILABLE'));
      }
    });
  }

  terminate(): void {
    this.closed = true;
    this.worker.terminate();
    for (const request of this.requests.values()) request.reject(new Error('STORAGE_UNAVAILABLE'));
    this.requests.clear();
  }

  async release(preserve: boolean): Promise<void> {
    const timeout = window.setTimeout(() => this.terminate(), 5000);
    try { await this.call({ type: 'release', preserve }); }
    finally {
      window.clearTimeout(timeout);
      this.terminate();
    }
  }
}

export const browserStorage: TransferStorage<File> = {
  pipeline: () => new FilePipeline(),
  records, openStored, discardPartial, chooseFile,
};

export async function probeStorage(): Promise<StorageProbe> {
  const pipeline = new FilePipeline();
  const timeout = window.setTimeout(() => pipeline.terminate(), 5000);
  try { return await pipeline.call<StorageProbe>({ type: 'probe' }); }
  catch { return { staging: null }; }
  finally {
    window.clearTimeout(timeout);
    pipeline.terminate();
  }
}

