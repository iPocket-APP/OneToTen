import { randomId } from '../shared/room.ts';
import type { Member } from '../shared/room.ts';
import type { Pair } from './pairs.ts';
import { textTooLong } from './protocol.ts';
import type { TextControl } from './protocol.ts';

interface TextMessage {
  id: string;
  peer: string;
  text: string;
}

export interface TextTransfer extends TextMessage {
  createdAt: number;
  direction: 'send' | 'receive';
  peerName: string;
}

interface PendingReceipt {
  pair: Pair;
  finish: (error?: unknown) => void;
}

const RECEIPT_TIMEOUT = 12_000;
const HISTORY_LIMIT = 100;

export class TextTransfers {
  private readonly pending = new Map<string, PendingReceipt>();
  private history: TextTransfer[] = [];
  private retry?: TextMessage;

  constructor(
    private readonly connect: (id: string) => Promise<Pair>,
    private readonly onChange: (history: TextTransfer[]) => void,
  ) {}

  async send(peer: Member, text: string): Promise<void> {
    if (!text.trim()) throw new Error('BAD_REQUEST');
    if (textTooLong(text)) throw new Error('TEXT_TOO_LONG');

    const pair = await this.connect(peer.id);
    if (pair.closed) throw new Error('CONNECTION_LOST');
    if (!pair.supportsText) throw new Error('TEXT_UNSUPPORTED');
    // A retry after a lost receipt should still count as the same message.
    const retry = this.retry;
    const message = retry?.peer === peer.id && retry.text === text && !this.pending.has(retry.id) ?
      retry : { id: randomId(), peer: peer.id, text };
    this.retry = message;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        window.clearTimeout(timeout);
        this.pending.delete(message.id);
        if (error === undefined) resolve();
        else reject(error);
      };
      const timeout = window.setTimeout(() => finish(new Error('TEXT_UNCONFIRMED')), RECEIPT_TIMEOUT);
      this.pending.set(message.id, { pair, finish });
      try { pair.send({ type: 'text.message', message_id: message.id, text }); }
      catch (error) { finish(error); }
    });
    if (this.retry === message) this.retry = undefined;
    this.record({ ...message, createdAt: Date.now(), direction: 'send', peerName: peer.name });
  }

  control(pair: Pair, message: TextControl): void {
    const id = message.message_id;
    if (message.type === 'text.ack') {
      const pending = this.pending.get(id);
      if (pending?.pair === pair) pending.finish();
      return;
    }
    const peer = pair.peer.id;
    if (!this.history.some((item) => item.direction === 'receive' && item.peer === peer && item.id === id)) {
      this.record({ id, peer, text: message.text, createdAt: Date.now(), direction: 'receive', peerName: pair.peer.name });
    }
    try { pair.send({ type: 'text.ack', message_id: id }); }
    catch { /* The receiver keeps the message if the receipt cannot be sent. */ }
  }

  pairClosed(pair: Pair, code: string): void {
    for (const pending of this.pending.values()) {
      if (pending.pair === pair) pending.finish(new Error(code));
    }
  }

  private record(message: TextTransfer): void {
    this.history = [message, ...this.history.slice(0, HISTORY_LIMIT - 1)];
    this.onChange(this.history);
  }
}
