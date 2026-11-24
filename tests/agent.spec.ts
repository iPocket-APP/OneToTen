import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join as pathJoin, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { devices, expect, test, webkit } from '@playwright/test';
import type { TransferView } from '../src/browser/transfers.ts';
import { record as fields } from '../src/shared/room.ts';
import { exportFile, hash, host, join, record, stage } from './browser-room.ts';

const cli = resolve('dist-agent/agent/cli.js');
const mimeType = 'application/octet-stream';

test('MCP device exchanges verified files with Chromium using its scoped folders', async ({ page, baseURL }, info) => {
  const inbox = info.outputPath('inbox');
  const outbox = info.outputPath('outbox');
  await Promise.all([mkdir(inbox, { recursive: true }), mkdir(outbox, { recursive: true })]);
  const incoming = Buffer.alloc(5 * 1024 ** 2 + 17, 'from the browser');
  const outgoing = Buffer.alloc(6 * 1024 ** 2 + 9, 'from the agent');
  await writeFile(pathJoin(inbox, '同名文件.bin'), 'keep');
  await writeFile(pathJoin(outbox, 'agent.bin'), outgoing);
  if (process.platform !== 'win32') await symlink(pathJoin(inbox, '同名文件.bin'), pathJoin(outbox, 'escape.bin'));

  const client = new Client({ name: 'file-room-test', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [cli, 'mcp', '--server', baseURL!, '--inbox', inbox, '--send-dir', outbox] });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const data = async (name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const reply = await call(name, args);
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
    expect(reply.structuredContent).toBeDefined();
    return fields(reply.structuredContent);
  };
  const wait = async (args?: Record<string, unknown>) =>
    (await data('file_room_wait', { timeout_seconds: 25, ...args })).transfer as TransferView;

  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(({ name }) => name)).toContain('file_room_send');
    expect((await data('file_room_status')).status).toBe('idle');
    const room = await data('file_room_create');
    const peerName = '浏览器';
    await join(page, room.invitation as string, peerName);
    await expect.poll(async () => (await data('file_room_status')).peers)
      .toEqual([expect.objectContaining({ name: peerName })]);
    const peers = (await data('file_room_status')).peers as { id: string; name: string }[];
    const peer = peers[0].id;

    for (const path of ['../inbox/同名文件.bin', ...(process.platform === 'win32' ? [] : ['escape.bin'])]) {
      const denied = await call('file_room_send', { peer_id: peer, paths: [path] });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({ code: 'PATH_OUTSIDE_SEND_DIRECTORY' });
    }
    await stage(page, 'AI Agent', { name: '同名文件.bin', mimeType, buffer: incoming });
    const offer = await wait({ from_peer_id: peer });
    expect(offer).toMatchObject({ phase: 'incoming', peer });
    expect(await readdir(inbox)).toEqual(['同名文件.bin']);
    await data('file_room_accept', { transfer_id: offer.id });
    const saved = await wait({ transfer_id: offer.id });
    expect(saved).toMatchObject({ phase: 'saved', sha256: hash(incoming) });
    expect(saved.localPath).toBe(pathJoin(inbox, '同名文件 (1).bin'));
    expect(hash(await readFile(saved.localPath!))).toBe(hash(incoming));
    expect(await readFile(pathJoin(inbox, '同名文件.bin'), 'utf8')).toBe('keep');
    await expect(record(page, 'send', '同名文件.bin')).toHaveAttribute('data-phase', 'saved');

    const sent = await data('file_room_send', { peer_id: peer, paths: ['agent.bin'] });
    const transferId = (sent.transferIds as string[])[0];
    const browserOffer = record(page, 'receive', 'agent.bin');
    await expect(browserOffer).toHaveAttribute('data-phase', 'incoming');
    await browserOffer.getByRole('button', { name: '接收并暂存' }).click();
    await exportFile(page, 'agent.bin', hash(outgoing));
    expect(await wait({ transfer_id: transferId })).toMatchObject({ phase: 'stored', sha256: hash(outgoing) });

    await stage(page, 'AI Agent', { name: 'decline.bin', mimeType, buffer: Buffer.from('decline') });
    const rejected = await wait();
    await data('file_room_reject', { transfer_id: rejected.id });
    await expect(record(page, 'send', 'decline.bin')).toHaveAttribute('data-phase', 'rejected');
    expect(await readdir(inbox)).toHaveLength(2);

    await page.evaluate(() => {
      const send = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function (this: RTCDataChannel, value: string | Blob | ArrayBuffer | ArrayBufferView) {
        if (typeof value === 'string' && value.includes('"type":"file.finish"')) {
          RTCDataChannel.prototype.send = send;
          value = JSON.stringify({ ...JSON.parse(value), digest: '0'.repeat(64) });
        }
        Reflect.apply(send, this, [value]);
      } as typeof send;
    });
    await stage(page, 'AI Agent', { name: 'bad-digest.bin', mimeType, buffer: Buffer.from('verify before publishing') });
    const invalid = await wait();
    await data('file_room_accept', { transfer_id: invalid.id });
    expect(await wait({ transfer_id: invalid.id })).toMatchObject({ phase: 'failed', code: 'HASH_MISMATCH' });
    await expect.poll(() => readdir(inbox)).toHaveLength(2);
    await data('file_room_leave');
    await expect(page.getByRole('button', { name: '选择 AI Agent', exact: true })).toHaveCount(0);

    const existing = await host(page, baseURL!, '已有房间');
    const wrongOrigin = existing.invitation.replace(new URL(baseURL!).origin, 'https://other.example');
    expect((await call('file_room_join', { invitation: wrongOrigin })).structuredContent).toMatchObject({ code: 'INVALID_INVITE' });
    expect(await data('file_room_join', { invitation: existing.invitation })).toMatchObject({
      status: 'online', roomId: existing.session.roomId,
    });
    await expect(page.getByRole('button', { name: '选择 AI Agent', exact: true })).toBeVisible();
  } finally {
    await client.close();
  }
});

function startCli(args: string[]) {
  const child = spawn(process.execPath, [cli, ...args, '--json', '--timeout', '35'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = once(child, 'close');
  return {
    async next() {
      const { value, done } = await lines.next();
      if (done) throw new Error('CLI exited before the event. ' + stderr);
      return JSON.parse(value);
    },
    async checkExit() {
      const [code] = await exited;
      expect(code, stderr).toBe(0);
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}

test('CLI can join a WebKit room to send and host a room to receive', async ({ baseURL }, info) => {
  const context = await webkit.launchPersistentContext(info.outputPath('webkit-profile'), {
    ...devices['iPhone 15'], locale: 'zh-CN', acceptDownloads: true,
  });
  try {
    const page = await context.newPage();
    const { invitation } = await host(page, baseURL!, 'WebKit');
    const list = startCli(['peers', '--invite', invitation]);
    try {
      expect(await list.next()).toMatchObject({ event: 'peers', peers: [{ name: 'WebKit' }] });
      await list.checkExit();
    } finally { await list.close(); }

    const outgoing = Buffer.from('CLI to WebKit');
    const source = info.outputPath('cli.bin');
    await writeFile(source, outgoing);
    const send = startCli(['send', '--invite', invitation, '--to', 'WebKit', source]);
    try {
      expect(await send.next()).toMatchObject({ event: 'queued' });
      const offer = record(page, 'receive', 'cli.bin');
      await expect(offer).toHaveAttribute('data-phase', 'incoming', { timeout: 25_000 });
      await offer.getByRole('button', { name: '接收并暂存' }).click();
      await exportFile(page, 'cli.bin', hash(outgoing));
      expect(await send.next()).toMatchObject({ event: 'transfer', transfer: { phase: 'stored', sha256: hash(outgoing) } });
      await send.checkExit();
    } finally { await send.close(); }

    const inbox = info.outputPath('received');
    const receive = startCli(['receive', '--server', baseURL!, '--out', inbox, '--accept']);
    try {
      const created = await receive.next();
      expect(created.event).toBe('invitation');
      await join(page, created.invitation, 'WebKit');
      const empty = Buffer.alloc(0);
      await stage(page, 'File Room CLI', { name: 'empty.bin', mimeType, buffer: empty });
      expect(await receive.next()).toMatchObject({ event: 'offer', transfer: { phase: 'incoming' } });
      expect(await receive.next()).toMatchObject({ event: 'transfer', transfer: { phase: 'saved', sha256: hash(empty) } });
      expect(await readdir(inbox)).toEqual(['empty.bin']);
      expect(await readFile(pathJoin(inbox, 'empty.bin'))).toEqual(empty);
      await expect(record(page, 'send', 'empty.bin')).toHaveAttribute('data-phase', 'saved');
      await receive.checkExit();
    } finally { await receive.close(); }
  } finally {
    await context.close();
  }
});
