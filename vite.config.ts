import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { siteHostname } from './cloudflare.config.ts';
import { lanHttp } from './dev/lan-http.ts';
import { localFinder } from './dev/local-finder.ts';
import { publicPages, siteOrigin } from './dev/public-pages.tsx';

function markTlsUpgrade(request: IncomingMessage): void {
  // The local Cloudflare adapter uses this header to construct the upgrade URL.
  if ((request.socket as TLSSocket).encrypted) request.headers['x-forwarded-proto'] = 'https';
}

const localTlsUpgrade: Plugin = {
  name: 'file-room-local-tls-upgrade',
  configureServer(server) { server.httpServer?.prependListener('upgrade', markTlsUpgrade); },
  configurePreviewServer(server) { server.httpServer.prependListener('upgrade', markTlsUpgrade); },
};

export default defineConfig(({ command, isPreview, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'FILE_ROOM_');
  const { FILE_ROOM_TLS_CERT: cert, FILE_ROOM_TLS_KEY: key } = env;
  if (Boolean(cert) !== Boolean(key)) throw new Error('Set both FILE_ROOM_TLS_CERT and FILE_ROOM_TLS_KEY');

  const development = command === 'serve' && !isPreview;
  const host = env.FILE_ROOM_HOST || '127.0.0.1';
  const productionOrigin = command === 'build' && mode === 'production' ? 'https://' + siteHostname : undefined;
  const origin = siteOrigin(env.FILE_ROOM_SITE_URL) ?? productionOrigin;
  const https = cert && key ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;
  const lanHttpEnabled = command === 'serve' && !https && !origin && env.FILE_ROOM_LAN_HTTP === '1';
  const finderEnabled = development && process.platform === 'darwin' && env.FILE_ROOM_LOCAL_FINDER === '1';
  const allowedHosts = [
    ...(origin ? [new URL(origin).hostname] : []),
    ...(host === '0.0.0.0' || host === '::' ? ['.local'] : []),
  ];
  return {
    plugins: [
      finderEnabled ? localFinder() : undefined,
      lanHttpEnabled ? lanHttp(host) : undefined,
      publicPages(origin),
      react(),
      cloudflare({ persistState: mode !== 'test' }),
      https ? localTlsUpgrade : undefined,
    ],
    define: {
      'import.meta.env.VITE_ROOM_LOCAL_FINDER': JSON.stringify(finderEnabled),
    },
    cacheDir: mode === 'test' ? 'node_modules/.vite-test' : undefined,
    server: {
      host,
      port: 5173,
      strictPort: true,
      https,
      allowedHosts: allowedHosts.length ? allowedHosts : undefined,
    },
    preview: {
      host,
      port: 4173,
      strictPort: true,
      https,
      allowedHosts: allowedHosts.length ? allowedHosts : undefined,
    },
    build: { target: 'es2022' },
    environments: {
      client: {
        build: { rolldownOptions: { input: ['index.html', 'guide.html', 'app.html', '404.html'] } },
      },
    },
    worker: { format: 'es' },
  };
});
