import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { finderMiddleware } from '../dev/local-finder.ts';

async function serve(revealFails = false) {
  const directory = await mkdtemp(join(tmpdir(), 'file-room-finder-test-'));
  const revealed: string[] = [];
  const middleware = finderMiddleware({
    directory,
    async reveal(path) {
      revealed.push(path);
      if (revealFails) throw new Error('Finder unavailable');
    },
  });
  const server = createServer((request, response) => {
    void middleware(request, response, () => { response.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  const route = origin + '/__file-room/finder';
  const send = (id: string, method: 'POST' | 'PUT', file?: { name: string; data: Buffer; digest?: string; origin?: string }) => {
    const headers: Record<string, string> = {
      Origin: file?.origin ?? origin,
      'X-File-Room-Action': 'finder',
    };
    if (file) {
      headers['X-File-Room-Name'] = encodeURIComponent(file.name);
      headers['X-File-Room-Size'] = String(file.data.length);
      if (file.digest) headers['X-File-Room-Sha256'] = file.digest;
    }
    return fetch(route + '/' + id, { method, headers, body: file ? new Uint8Array(file.data) : undefined });
  };
  return {
    directory, route, revealed, send,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Finder saves verified bytes with a collision-safe name and reuses the saved file', async () => {
  const service = await serve();
  try {
    assert.equal((await fetch(service.route)).status, 404);
    assert.equal((await fetch(service.route, { headers: { 'X-File-Room-Action': 'finder' } })).status, 200);
    const id = randomUUID();
    const absent = await service.send(id, 'POST');
    assert.equal(absent.status, 404);
    assert.deepEqual(await absent.json(), { code: 'FILE_NOT_EXPORTED' });
    const original = join(service.directory, 'voice.wav');
    await writeFile(original, 'original');
    const data = Buffer.from('received content');
    const digest = createHash('sha256').update(data).digest('hex');
    const saved = await service.send(id, 'PUT', { name: 'voice.wav', data, digest });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { name: 'voice (1).wav', revealed: true });
    const repeated = await service.send(id, 'POST');
    assert.deepEqual(await repeated.json(), { name: 'voice (1).wav', revealed: true });
    assert.equal(await readFile(original, 'utf8'), 'original');
    const exported = join(service.directory, 'voice (1).wav');
    assert.deepEqual(await readFile(exported), data);
    assert.deepEqual(service.revealed, [exported, exported]);
    assert.deepEqual((await readdir(service.directory)).sort(), ['voice (1).wav', 'voice.wav']);
  } finally { await service.close(); }
});

test('Finder rejects cross-origin saves and invalid hashes without leaving a file', async () => {
  const service = await serve();
  try {
    const data = Buffer.from('received content');
    const denied = await service.send(randomUUID(), 'PUT', { name: 'voice.wav', data, origin: 'http://outside.test' });
    assert.equal(denied.status, 404);
    const corrupt = await service.send(randomUUID(), 'PUT', { name: 'voice.wav', data, digest: '0'.repeat(64) });
    assert.equal(corrupt.status, 422);
    assert.deepEqual(await corrupt.json(), { code: 'HASH_MISMATCH' });
    assert.deepEqual(service.revealed, []);
    assert.deepEqual(await readdir(service.directory), []);
  } finally { await service.close(); }
});

test('a Finder reveal failure still reports the file already saved in Downloads', async () => {
  const service = await serve(true);
  try {
    const data = Buffer.from('received content');
    const saved = await service.send(randomUUID(), 'PUT', { name: 'voice.wav', data });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { name: 'voice.wav', revealed: false });
    assert.deepEqual(await readFile(join(service.directory, 'voice.wav')), data);
  } finally { await service.close(); }
});

