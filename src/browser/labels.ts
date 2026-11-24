import type { Device } from '../shared/room.ts';

export function codeOf(error: unknown, fallback = 'SERVER_ERROR'): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'PICKER_CANCELLED';
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'QUOTA_EXCEEDED';
  if (error instanceof Error && /^[A-Z_]{1,40}$/.test(error.message)) return error.message;
  return fallback;
}

export function localDevice(defaultName: string): Device {
  const agent = navigator.userAgent;
  if (/iPad/.test(agent) || /Macintosh/.test(agent) && navigator.maxTouchPoints > 1) return { name: 'iPad', kind: 'tablet' };
  if (/iPhone/.test(agent)) return { name: 'iPhone', kind: 'iphone' };
  if (/Android/.test(agent)) return { name: 'Android', kind: 'android' };
  if (/Macintosh/.test(agent)) return { name: 'Mac', kind: 'desktop' };
  if (/Windows/.test(agent)) return { name: 'Windows', kind: 'desktop' };
  if (/Linux/.test(agent)) return { name: 'Linux', kind: 'desktop' };
  return { name: defaultName, kind: 'other' };
}
