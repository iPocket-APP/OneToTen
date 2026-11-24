import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { Plugin } from 'vite';

export const LAN_HTTP_ROUTE = '/__file-room/lan-http';
const wildcardHosts = new Set(['0.0.0.0', '::']);

function reply(response: ServerResponse, status: number, body: object): void {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function stripIpv4Mapped(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (!lower.startsWith('::ffff:')) return lower;
  const tail = lower.slice(7);
  if (isIP(tail) === 4) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return lower;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function parseConfiguredHost(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || /[\s/?#@\\]/.test(trimmed)) return undefined;
  const authority = trimmed.includes(':') && !trimmed.startsWith('[') ? '[' + trimmed + ']' : trimmed;
  const parsed = URL.parse('http://' + authority);
  if (!parsed || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash ||
      parsed.username || parsed.password) {
    return undefined;
  }
  return stripIpv4Mapped(parsed.hostname.replace(/^\[|\]$/g, ''));
}

function parseRequestHost(header: string | undefined): string | undefined {
  if (!header || /[\s/?#@\\]/.test(header)) return undefined;
  const parsed = URL.parse('http://' + header);
  if (!parsed || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    return undefined;
  }
  return stripIpv4Mapped(parsed.hostname.replace(/^\[|\]$/g, ''));
}

function normalizeSocketIp(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const clean = address.split('%')[0];
  if (clean.includes(':')) {
    const parsed = URL.parse('http://[' + clean + ']');
    return parsed ? stripIpv4Mapped(parsed.hostname.replace(/^\[|\]$/g, '')) : undefined;
  }
  return isIP(clean) === 4 ? clean : undefined;
}

export function isLocalNetworkIp(ip: string): boolean {
  const normalized = stripIpv4Mapped(ip);
  const family = isIP(normalized);
  if (family === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  if (family === 6) {
    return normalized === '::1' || /^f[cd][0-9a-f]{2}:/.test(normalized) || /^fe[89ab][0-9a-f]:/.test(normalized);
  }
  return false;
}

export function isLoopbackHost(raw: string): boolean {
  const host = parseConfiguredHost(raw);
  return host === 'localhost' || host === '::1' || (host !== undefined && host.startsWith('127.') && isIP(host) === 4);
}

export function lanHttpMiddleware(configuredHost: string) {
  const target = parseConfiguredHost(configuredHost);
  const wildcard = target !== undefined && wildcardHosts.has(target);

  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const path = request.url?.split('?')[0] ?? '';
    if (path !== LAN_HTTP_ROUTE) {
      next();
      return;
    }
    if (!target || isLoopbackHost(target) || request.method !== 'GET' ||
        request.headers['x-file-room-action'] !== 'lan-http' ||
        (request.socket as TLSSocket).encrypted ||
        request.headers.forwarded || request.headers['x-forwarded-for'] || request.headers['x-forwarded-proto']) {
      reply(response, 404, { allowed: false });
      return;
    }
    const requestHost = parseRequestHost(request.headers.host);
    if (!requestHost) {
      reply(response, 404, { allowed: false });
      return;
    }
    if (wildcard) {
      const remoteIp = normalizeSocketIp(request.socket.remoteAddress);
      const localIp = normalizeSocketIp(request.socket.localAddress);
      const hostMatchesLan = requestHost === localIp || requestHost.endsWith('.local') || isLocalNetworkIp(requestHost);
      if (!remoteIp || !localIp || !isLocalNetworkIp(remoteIp) || !isLocalNetworkIp(localIp) || !hostMatchesLan) {
        reply(response, 404, { allowed: false });
        return;
      }
    } else if (requestHost !== target) {
      reply(response, 404, { allowed: false });
      return;
    }
    reply(response, 200, { allowed: true });
  };
}

function configuredBindHost(host: string | boolean | undefined, fallback: string): string {
  if (typeof host === 'string') return host;
  return host === true ? '0.0.0.0' : fallback;
}

export function lanHttp(fallbackHost: string): Plugin {
  return {
    name: 'file-room-lan-http',
    enforce: 'pre',
    configureServer(server) {
      const handle = lanHttpMiddleware(configuredBindHost(server.config.server.host, fallbackHost));
      server.middlewares.use((request, response, next) => handle(request, response, next));
    },
    configurePreviewServer(server) {
      const handle = lanHttpMiddleware(configuredBindHost(server.config.preview.host, fallbackHost));
      server.middlewares.use((request, response, next) => handle(request, response, next));
    },
  };
}
