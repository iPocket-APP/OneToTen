import { bindings, defineConfig, exports } from 'cf/config';

const name = 'browser-file-room';
export const siteHostname = '1210.ipocket.xyz';

export default defineConfig({
  worker: {
    name,
    domains: [siteHostname],
    workersDev: true,
    entrypoint: './src/worker/index.ts',
    compatibilityDate: '2026-11-23',
    assets: { notFoundHandling: '404-page', runWorkerFirst: ['/api', '/api/*', '/join/*', '/room/*'] },
    exports: { Room: exports.durableObject({ storage: 'sqlite' }) },
    env: {
      ASSETS: bindings.assets(),
      ROOMS: bindings.durableObject({ worker: name, exportName: 'Room' }),
      ROOM_LIMIT: bindings.rateLimit({ namespace: '1010', simple: { limit: 90, period: 60 } }),
    },
  },
});
