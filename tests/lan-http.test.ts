import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import test from 'node:test';
import { isLocalNetworkIp, isLoopbackHost, LAN_HTTP_ROUTE, lanHttpMiddleware } from '../dev/lan-http.ts';

async function serve(host: string) {
  const middleware = lanHttpMiddleware(host);
  const server = createServer((request, response) => {
    middleware(request, response, () => { response.writeHead(404).end('passthrough'); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  return {
    origin,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function invoke(host: string, options: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  encrypted?: boolean;
  localAddress?: string;
  remoteAddress?: string;
}) {
  const middleware = lanHttpMiddleware(host);
  let status = 0;
  let body = '';
  let nextCalled = false;
  const request = {
    url: options.url ?? LAN_HTTP_ROUTE,
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    socket: {
      encrypted: options.encrypted ?? false,
      localAddress: options.localAddress ?? '192.168.1.100',
      remoteAddress: options.remoteAddress ?? '192.168.1.42',
    },
  } as unknown as IncomingMessage;
  const response = {
    destroyed: false,
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { body = chunk ?? ''; },
  } as unknown as ServerResponse;
  middleware(request, response, () => { nextCalled = true; });
  return { status, body: body ? JSON.parse(body) as { allowed?: boolean } : undefined, nextCalled };
}

test('LAN HTTP middleware allows matching host on direct plain HTTP and rejects proxies or mismatches', () => {
  const allowed = invoke('192.168.1.100', {
    headers: { host: '192.168.1.100:4173', 'x-file-room-action': 'lan-http' },
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body, { allowed: true });

  const withoutAction = invoke('192.168.1.100', { headers: { host: '192.168.1.100:4173' } });
  assert.equal(withoutAction.status, 404);

  const wrongHost = invoke('192.168.1.100', {
    headers: { host: '192.168.1.101:4173', 'x-file-room-action': 'lan-http' },
  });
  assert.equal(wrongHost.status, 404);

  const proxied = invoke('192.168.1.100', {
    headers: { host: '192.168.1.100:4173', 'x-file-room-action': 'lan-http', 'x-forwarded-for': '203.0.113.9' },
  });
  assert.equal(proxied.status, 404);

  const tls = invoke('192.168.1.100', {
    headers: { host: '192.168.1.100:4173', 'x-file-room-action': 'lan-http' },
    encrypted: true,
  });
  assert.equal(tls.status, 404);

  const loopback = invoke('127.0.0.1', {
    headers: { host: '127.0.0.1:4173', 'x-file-room-action': 'lan-http' },
  });
  assert.equal(loopback.status, 404);

  const passthrough = invoke('192.168.1.100', { url: '/api/v1/rooms' });
  assert.equal(passthrough.nextCalled, true);
});

test('LAN HTTP wildcard bind allows only private network clients and local hosts', () => {
  const lanIp = invoke('0.0.0.0', {
    headers: { host: '192.168.1.100:4173', 'x-file-room-action': 'lan-http' },
    localAddress: '::ffff:192.168.1.100',
    remoteAddress: '::ffff:192.168.1.25',
  });
  assert.equal(lanIp.status, 200);
  assert.deepEqual(lanIp.body, { allowed: true });

  const mdns = invoke('0.0.0.0', {
    headers: { host: 'studio-mac.local:4173', 'x-file-room-action': 'lan-http' },
    localAddress: '10.0.0.5',
    remoteAddress: '10.0.0.18',
  });
  assert.equal(mdns.status, 200);
  assert.deepEqual(mdns.body, { allowed: true });

  const publicClient = invoke('0.0.0.0', {
    headers: { host: '192.168.1.100:4173', 'x-file-room-action': 'lan-http' },
    localAddress: '192.168.1.100',
    remoteAddress: '198.51.100.8',
  });
  assert.equal(publicClient.status, 404);

  const publicHost = invoke('0.0.0.0', {
    headers: { host: 'files.example.com:4173', 'x-file-room-action': 'lan-http' },
    localAddress: '192.168.1.100',
    remoteAddress: '192.168.1.25',
  });
  assert.equal(publicHost.status, 404);
});

test('LAN HTTP helpers classify private IPs and loopback hosts accurately', async () => {
  assert.equal(isLocalNetworkIp('10.1.2.3'), true);
  assert.equal(isLocalNetworkIp('172.16.0.1'), true);
  assert.equal(isLocalNetworkIp('172.32.0.1'), false);
  assert.equal(isLocalNetworkIp('192.168.1.10'), true);
  assert.equal(isLocalNetworkIp('100.64.1.2'), true);
  assert.equal(isLocalNetworkIp('8.8.8.8'), false);
  assert.equal(isLocalNetworkIp('fd12::1'), true);
  assert.equal(isLocalNetworkIp('fe80::1'), true);
  assert.equal(isLocalNetworkIp('2001:db8::1'), false);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('192.168.1.100'), false);

  const service = await serve('0.0.0.0');
  try {
    const allowed = await fetch(service.origin + LAN_HTTP_ROUTE, { headers: { 'X-File-Room-Action': 'lan-http' } });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { allowed: true });
    const other = await fetch(service.origin + '/other');
    assert.equal(other.status, 404);
    assert.equal(await other.text(), 'passthrough');
  } finally {
    await service.close();
  }
});
