import { openStored } from './storage-model.ts';
import type { ShelfItem } from './transfers.ts';

const route = '/__file-room/finder';
const action = { 'X-File-Room-Action': 'finder' };
interface FinderResult { name: string; revealed: boolean }

export async function canRevealLocalFile(): Promise<boolean> {
  if (!import.meta.env.DEV || import.meta.env.VITE_ROOM_LOCAL_FINDER !== true) return false;
  try {
    const response = await fetch(route, { headers: action });
    return response.ok && (await response.json()).available === true;
  } catch { return false; }
}

export async function revealReceivedFile(item: ShelfItem): Promise<FinderResult> {
  const url = route + '/' + item.id;
  let response = await fetch(url, { method: 'POST', headers: action });
  let result = await response.json();
  if (response.status === 404 && result.code === 'FILE_NOT_EXPORTED') {
    const file = item.memoryFile ?? (item.entry ? await openStored(item.entry) : undefined);
    if (!file) throw new Error('EXPORT_UNAVAILABLE');
    const headers = new Headers(action);
    headers.set('X-File-Room-Name', encodeURIComponent(item.file.name));
    headers.set('X-File-Room-Size', item.file.size_bytes);
    if (item.entry?.digest) headers.set('X-File-Room-Sha256', item.entry.digest);
    response = await fetch(url, { method: 'PUT', headers, body: file });
    result = await response.json();
  }
  if (!response.ok || typeof result.name !== 'string' || typeof result.revealed !== 'boolean') {
    throw new Error(result.code ?? 'SAVE_UNAVAILABLE');
  }
  return result as FinderResult;
}

