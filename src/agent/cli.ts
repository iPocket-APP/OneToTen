#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { cleanup } from 'node-datachannel';
import { MAX_BATCH_FILES, isUuid } from '../shared/room.ts';
import { failure } from './errors.ts';
import { localDirectory } from './files.ts';
import { AgentRoom, invitation, serverOrigin, succeeded } from './room.ts';

const help = `One to Ten · File Room

  file-room peers --invite URL [--json]
  file-room send (--invite URL | --server ORIGIN) --to ID_OR_NAME [--json] FILE...
  file-room receive (--invite URL | --server ORIGIN) [--out DIRECTORY] [--from PEER_ID] [--accept] [--json]
  file-room mcp --server ORIGIN [--inbox DIRECTORY] [--send-dir DIRECTORY]

  --name NAME          Name shown to other devices.
  --timeout SECONDS    CLI deadline, 1–7200 seconds (default 300).
  --allow-http         Allow HTTP outside loopback on a trusted local network.
  --stun URL           Optional stun: server for direct WebRTC connections.
  --json               Newline-delimited JSON. Diagnostics go to stderr.
  --accept             Accept one matching offer without a terminal prompt.
  --help               Show this help.

  FILE_ROOM_SERVER, FILE_ROOM_INVITE and FILE_ROOM_STUN_URL can supply the corresponding settings.
  The default inbox is "One to Ten" in Downloads.`;

const argumentOptions = {
  server: { type: 'string' }, invite: { type: 'string' }, name: { type: 'string' },
  stun: { type: 'string' }, timeout: { type: 'string' }, 'allow-http': { type: 'boolean' },
  to: { type: 'string' }, from: { type: 'string' }, out: { type: 'string' }, accept: { type: 'boolean' },
  inbox: { type: 'string' }, 'send-dir': { type: 'string' }, json: { type: 'boolean' },
} as const;
const defaultInbox = join(homedir(), 'Downloads', 'One to Ten');

function stunUrl(raw: string | undefined): string | undefined {
  if (raw && !/^stun:(?:\[[\da-f:.]+\]|[a-z\d.-]+)(?::\d{1,5})?$/i.test(raw)) throw new Error('INVALID_STUN');
  return raw;
}

function print(json: boolean, data: object, text: string): void {
  console.log(json ? JSON.stringify(data) : text);
}

async function sendFiles(room: AgentRoom, target: string, paths: string[], host: boolean, json: boolean, signal: AbortSignal): Promise<void> {
  if (host) await room.waitFor(() => room.peers().some(({ id, name }) => id === target || name === target) ? true : undefined, signal);
  const transferIds = await room.send(target, paths, undefined, signal);
  print(json, { event: 'queued', transferIds }, 'Waiting for the other device to accept ' + transferIds.length + ' file(s).');
  for (const id of transferIds) {
    const transfer = await room.waitForTransfer(id, signal);
    print(json, { event: 'transfer', transfer }, transfer.file.name + ' · ' +
      (succeeded(transfer) ? 'Receiver confirmed SHA-256 ' + transfer.sha256 : failure(new Error(transfer.code ?? 'TRANSFER_UNAVAILABLE')).message));
    if (!succeeded(transfer)) process.exitCode = 1;
  }
}

async function confirmOffer(room: AgentRoom, id: string, signal: AbortSignal): Promise<boolean | undefined> {
  const completed = new AbortController();
  const waiting = AbortSignal.any([signal, completed.signal]);
  const prompt = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  try {
    return await Promise.race([
      prompt.question('Accept this file? [y/N] ', { signal: waiting }).then((answer) => /^y(?:es)?$/i.test(answer.trim())),
      room.waitFor(() => room.transfer(id)?.phase === 'incoming' ? undefined : true, waiting).then(() => undefined),
    ]);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    completed.abort();
    prompt.close();
  }
}

async function receiveFile(room: AgentRoom, from: string | undefined, autoAccept: boolean, json: boolean, signal: AbortSignal) {
  for (;;) {
    const offer = await room.waitForOffer(undefined, signal);
    if (from && offer.peer !== from) { room.reject(offer.id); continue; }
    print(json, { event: 'offer', transfer: offer }, offer.peerName + ' offers ' + offer.file.name + ' (' + offer.file.size_bytes + ' bytes).');
    if (!autoAccept) {
      const accepted = await confirmOffer(room, offer.id, signal);
      if (accepted === undefined || room.transfer(offer.id)?.phase !== 'incoming') continue;
      if (!accepted) { room.reject(offer.id); continue; }
    }
    room.accept(offer.id);
    const transfer = await room.waitForTransfer(offer.id, signal);
    if (!succeeded(transfer)) throw new Error(transfer.code ?? 'TRANSFER_UNAVAILABLE');
    print(json, { event: 'transfer', transfer }, 'Saved ' + transfer.localPath + '\nSHA-256 ' + transfer.sha256);
    // Give the final control-channel receipt time to reach the browser before this one-shot peer exits.
    await delay(600);
    return;
  }
}

async function main(args: string[], lifetime: AbortSignal): Promise<void> {
  const [command, ...argv] = args;
  if (!command || args.includes('--help') || command === '-h') { console.log(help); return; }
  if (command !== 'peers' && command !== 'send' && command !== 'receive' && command !== 'mcp') {
    throw new Error('BAD_ARGUMENTS');
  }
  const { values, positionals } = parseArgs({ args: argv, options: argumentOptions, allowPositionals: command === 'send' });
  const allowHttp = values['allow-http'] ?? false;
  const server = values.server ?? process.env.FILE_ROOM_SERVER;
  const origin = server ? serverOrigin(server, allowHttp) : undefined;
  const name = values.name ?? (command === 'mcp' ? 'AI Agent' : 'File Room CLI');
  const stun = stunUrl(values.stun ?? process.env.FILE_ROOM_STUN_URL);
  if (command === 'mcp') {
    if (!origin) throw new Error('SERVER_REQUIRED');
    if (values.invite || values.to || values.from || values.out || values.accept || values.timeout || values.json) {
      throw new Error('BAD_ARGUMENTS');
    }
    const inbox = resolve(values.inbox ?? defaultInbox);
    const sendDirectory = values['send-dir'] ? await localDirectory(values['send-dir']) : undefined;
    const { runMcp } = await import('./mcp.ts');
    await runMcp({ origin, name, inbox, stun, sendDirectory, allowHttp }, lifetime);
    return;
  }

  if (values.inbox || values['send-dir'] || (command !== 'receive' && (values.out || values.from || values.accept)) ||
      (command !== 'send' && values.to)) throw new Error('BAD_ARGUMENTS');
  if (command === 'send' && (!values.to || !positionals.length || positionals.length > MAX_BATCH_FILES)) {
    throw new Error('BAD_ARGUMENTS');
  }
  if (command === 'receive') {
    if (values.from && !isUuid(values.from)) throw new Error('BAD_ARGUMENTS');
    if (!values.accept && !process.stdin.isTTY) throw new Error('ACCEPT_REQUIRED');
  }
  const seconds = Number(values.timeout ?? 300);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 7200) throw new Error('BAD_ARGUMENTS');
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(seconds * 1000)]);
  const rawInvite = values.invite ?? process.env.FILE_ROOM_INVITE;
  const invite = rawInvite === undefined ? undefined : invitation(rawInvite, origin, allowHttp);
  const targetOrigin = invite?.origin ?? origin;
  if (!targetOrigin || (command === 'peers' && !invite)) throw new Error('ROOM_REQUIRED');
  const options = { name, inbox: resolve(values.out ?? defaultInbox), origin: targetOrigin, stun };
  const room = invite ? await AgentRoom.join(options, invite, signal) : await AgentRoom.create(options, signal);
  const json = values.json ?? false;
  try {
    const status = room.status();
    if (status.invitation) {
      print(json, { event: 'invitation', roomId: status.roomId, invitation: status.invitation,
        expiresAt: status.inviteExpiresAt }, 'Open this invitation on the other device:\n' + status.invitation);
    }
    if (command === 'peers') {
      const peers = room.peers();
      print(json, { event: 'peers', peers }, peers.length ? peers.map(({ id, name }) => id + '  ' + name).join('\n') : 'No other devices are online.');
    } else if (command === 'send') {
      await sendFiles(room, values.to!, positionals, !invite, json, signal);
    } else {
      await receiveFile(room, values.from, Boolean(values.accept), json, signal);
    }
  } finally {
    await room.close();
  }
}

const args = process.argv.slice(2);
const lifetime = new AbortController();
const interrupt = () => lifetime.abort(new Error('INTERRUPTED'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  await main(args, lifetime.signal);
} catch (error) {
  const problem = failure(error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS_')
    ? new Error('BAD_ARGUMENTS') : error);
  if (args[0] !== 'mcp' && args.includes('--json')) print(true, { event: 'error', ...problem }, '');
  console.error('file-room [' + problem.code + '] ' + problem.message);
  process.exitCode = problem.code === 'INTERRUPTED' ? 130 : 1;
} finally {
  cleanup();
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
