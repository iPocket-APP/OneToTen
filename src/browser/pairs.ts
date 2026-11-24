import { PROTOCOL, VERSION, pairId, randomId } from '../shared/room.ts';
import type { Member, RoomEvent, Session, Signal } from '../shared/room.ts';
import { decodeControl, encodeControl, messageLimit, SEND_LOW_WATER } from './protocol.ts';
import type { Control, SaveMode, TextControl, TransferControl } from './protocol.ts';

type IncomingSignal = Extract<RoomEvent, { from_instance: string }>;
type SignalBody = { [K in Signal['type']]: Pick<Extract<Signal, { type: K }>, 'type' | 'payload'> }[Signal['type']];
type Timer = ReturnType<typeof setTimeout>;
type DataPeerConnection = Pick<RTCPeerConnection, 'connectionState' | 'onconnectionstatechange' | 'onicecandidate' |
  'createDataChannel' | 'createOffer' | 'createAnswer' | 'setLocalDescription' | 'localDescription' |
  'setRemoteDescription' | 'addIceCandidate' | 'getStats' | 'sctp' | 'close'> & Pick<EventTarget, 'addEventListener'>;
export type ConnectionPath = 'direct' | 'unknown';

interface SignalClient {
  session: Session;
  send: (signal: Signal) => void;
}

interface PairEvents {
  control: (pair: Pair, message: TransferControl | TextControl) => void;
  bulk: (pair: Pair, buffer: ArrayBuffer) => void;
  close: (pair: Pair, code: string) => void;
  modes: () => SaveMode[];
  text?: true;
}

const CONNECT_TIMEOUT = 20_000;

export class Pair {
  readonly ready: Promise<Pair>;
  control?: RTCDataChannel;
  bulk?: RTCDataChannel;
  path: ConnectionPath = 'unknown';
  isReady = false;
  supportsText = false;
  closed = false;
  lastSequence = 0;
  private sequence = 0;
  private receivedHello = false;
  private acknowledged = false;
  private helloTimer?: Timer;
  private announced = false;
  private remoteSet = false;
  private readonly outgoingIce: RTCIceCandidate[] = [];
  private readonly incomingIce: RTCIceCandidateInit[] = [];
  private resolve!: (pair: Pair) => void;
  private reject!: (error: Error) => void;
  private readonly timeout: Timer;
  private disconnectTimer?: Timer;

  constructor(
    public peer: Member,
    readonly epoch: string,
    private readonly client: SignalClient,
    private readonly events: PairEvents,
    readonly pc: DataPeerConnection,
  ) {
    this.ready = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.ready.catch(() => undefined);
    this.timeout = setTimeout(() => this.close('DIRECT_CONNECTION_FAILED'), CONNECT_TIMEOUT);
    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate?.candidate || this.closed) return;
      try {
        if (this.announced) this.sendIce(candidate);
        else this.outgoingIce.push(candidate);
      } catch { this.close('SIGNAL_DISCONNECTED'); }
    };
    this.pc.addEventListener('datachannel', (event) => this.attach((event as RTCDataChannelEvent).channel));
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'closed' || state === 'failed') this.close(this.isReady ? 'CONNECTION_LOST' : 'DIRECT_CONNECTION_FAILED');
      else if (state === 'disconnected' && this.disconnectTimer === undefined) {
        this.disconnectTimer = setTimeout(() => this.close('CONNECTION_LOST'), 7000);
      } else if (state === 'connected') {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = undefined;
      }
    };
  }

  async offer(): Promise<void> {
    this.attach(this.pc.createDataChannel('control', { ordered: true }));
    this.attach(this.pc.createDataChannel('bulk', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.announce('rtc.offer');
  }

  async accept(signal: IncomingSignal): Promise<void> {
    if (this.closed || signal.seq <= this.lastSequence) return;
    this.lastSequence = signal.seq;
    if (signal.type === 'rtc.ice') {
      if (this.remoteSet) await this.pc.addIceCandidate(signal.payload);
      else if (this.incomingIce.length < 128) this.incomingIce.push(signal.payload);
      return;
    }
    if (signal.type === 'connect.request') return;
    if (this.remoteSet) return;
    await this.pc.setRemoteDescription(signal.payload);
    this.remoteSet = true;
    for (const candidate of this.incomingIce.splice(0)) await this.pc.addIceCandidate(candidate);
    if (signal.type === 'rtc.offer') {
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      this.announce('rtc.answer');
    }
  }

  private announce(type: 'rtc.offer' | 'rtc.answer'): void {
    const sdp = this.pc.localDescription?.sdp;
    if (this.closed || !sdp) throw new Error('DIRECT_CONNECTION_FAILED');
    if (type === 'rtc.offer') this.signal({ type, payload: { type: 'offer', sdp } });
    else this.signal({ type, payload: { type: 'answer', sdp } });
    this.announced = true;
    for (const candidate of this.outgoingIce.splice(0)) this.sendIce(candidate);
  }

  private sendIce(c: RTCIceCandidate): void {
    this.signal({ type: 'rtc.ice', payload: {
      candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment ?? null,
    } });
  }

  private signal(body: SignalBody): void {
    sendSignal(this.client, this.peer, this.epoch, ++this.sequence, body);
  }

  private attach(channel: RTCDataChannel): void {
    if (this.closed || (channel.label !== 'control' && channel.label !== 'bulk') || this[channel.label] ||
        !channel.ordered || channel.maxPacketLifeTime !== null || channel.maxRetransmits !== null) {
      channel.close();
      return;
    }
    const label = channel.label;
    this[label] = channel;
    channel.onclose = () => this.close('CONNECTION_LOST');
    channel.onerror = () => this.close('CONNECTION_LOST');
    if (label === 'bulk') {
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = SEND_LOW_WATER;
    }
    channel.onopen = () => this.opened();
    channel.onmessage = ({ data }) => {
      if (this.closed) return;
      try {
        if (label === 'bulk') {
          if (!(data instanceof ArrayBuffer)) throw new Error('INVALID_FRAME');
          this.events.bulk(this, data);
          return;
        }
        const message = decodeControl(data);
        if (message.type === 'hello') {
          this.receivedHello = true;
          this.supportsText = message.text === true;
          this.send({ type: 'hello.ack', protocol: PROTOCOL });
          this.opened();
        } else if (message.type === 'hello.ack') {
          this.acknowledged = true;
          clearInterval(this.helloTimer);
          this.opened();
        } else if (this.receivedHello) {
          this.events.control(this, message);
        }
      } catch { this.close('PROTOCOL_MISMATCH'); }
    };
    if (channel.readyState === 'open') this.opened();
  }

  private opened(): void {
    if (this.closed || this.isReady) return;
    try {
      if (this.control?.readyState === 'open' && !this.acknowledged && this.helloTimer === undefined) {
        const greet = () => {
          try { this.send({ type: 'hello', protocol: PROTOCOL, modes: this.events.modes(), text: this.events.text }); }
          catch { this.close('CONNECTION_LOST'); }
        };
        this.helloTimer = setInterval(greet, 350);
        greet();
      }
      if (!this.acknowledged || !this.receivedHello || this.bulk?.readyState !== 'open') return;
      this.isReady = true;
      clearTimeout(this.timeout);
      const allowance = new Promise<void>((resolve) => setTimeout(resolve, 250));
      void Promise.race([this.identifyPath(), allowance]).then(() => {
        if (!this.closed) this.resolve(this);
      });
    } catch { this.close('MESSAGE_TOO_LARGE'); }
  }

  private async identifyPath(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      const entries = Array.from(stats.values());
      const selectedId = entries.find((entry) => entry.type === 'transport' && entry.selectedCandidatePairId)?.selectedCandidatePairId;
      const pair = stats.get(selectedId) ?? entries.find((entry) =>
        entry.type === 'candidate-pair' && entry.state === 'succeeded' && (entry.selected || entry.nominated));
      if (!pair) return;
      const localType = stats.get(pair.localCandidateId)?.candidateType;
      const remoteType = stats.get(pair.remoteCandidateId)?.candidateType;
      if (localType === 'relay' || remoteType === 'relay') this.close('RELAY_NOT_ALLOWED');
      else if (localType && remoteType) this.path = 'direct';
    } catch { /* Some browsers omit the selected candidate. */ }
  }

  maxMessage(): number { return messageLimit(this.pc.sctp?.maxMessageSize); }

  send(message: Control): void {
    if (this.control?.readyState !== 'open' || this.closed) throw new Error('CONNECTION_LOST');
    this.control.send(encodeControl(message, this.maxMessage()));
  }

  close(code: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timeout);
    clearTimeout(this.disconnectTimer);
    clearInterval(this.helloTimer);
    this.reject(new Error(code));
    this.pc.close();
    this.events.close(this, code);
  }
}

function sendSignal(client: SignalClient, peer: Member, epoch: string, seq: number, body: SignalBody) {
  const { peerId, roomId } = client.session;
  client.send({
    ...body, v: VERSION, to: peer.id, to_instance: peer.instance, room_id: roomId,
    pair_id: pairId(peerId, peer.id), connection_epoch: epoch, seq,
  } satisfies Signal);
}

interface AwaitOffer {
  promise: Promise<Pair>;
  resolve: (pair: Pair) => void;
  reject: (error: Error) => void;
  timer: Timer;
}

export class Pairs {
  private readonly pairs = new Map<string, Pair>();
  private readonly pending = new Map<string, AwaitOffer>();
  private readonly serial = new Map<string, Promise<void>>();
  private readonly retired = new Set<string>();
  private destroyed = false;

  constructor(
    private readonly client: SignalClient,
    private readonly member: (id: string) => Member | undefined,
    private readonly events: PairEvents,
    private readonly connect: () => DataPeerConnection,
  ) {}

  ensure(id: string): Promise<Pair> {
    const current = this.pairs.get(id);
    if (current && !current.closed) return current.ready;
    const peer = this.member(id);
    if (!peer) return Promise.reject(new Error('PEER_OFFLINE'));
    if (this.client.session.peerId < id) return this.offer(peer).ready;
    const pending = this.pending.get(id);
    if (pending) return pending.promise;

    sendSignal(this.client, peer, randomId(), 1, { type: 'connect.request', payload: null });
    let resolve!: (pair: Pair) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Pair>((ok, fail) => { resolve = ok; reject = fail; });
    const timer = setTimeout(() => this.rejectPending(id, 'DIRECT_CONNECTION_FAILED'), CONNECT_TIMEOUT);
    this.pending.set(id, { promise, resolve, reject, timer });
    return promise;
  }

  signal(signal: IncomingSignal): void {
    const id = signal.from;
    const previous = this.serial.get(id) ?? Promise.resolve();
    const current = previous.then(() => this.handle(signal)).catch(() => this.pairs.get(id)?.close('DIRECT_CONNECTION_FAILED'));
    this.serial.set(id, current);
    void current.finally(() => { if (this.serial.get(id) === current) this.serial.delete(id); });
  }

  private async handle(signal: IncomingSignal): Promise<void> {
    const peer = this.member(signal.from);
    if (this.destroyed || !peer || peer.instance !== signal.from_instance ||
        this.retired.has(signal.connection_epoch)) return;
    let pair = this.pairs.get(peer.id);
    if (signal.type === 'connect.request') {
      // A peer requests a new generation only when it has no current pair.
      if (!pair || pair.isReady) {
        pair?.close('CONNECTION_LOST');
        this.offer(peer);
      }
      return;
    }
    if (signal.type === 'rtc.offer' && pair?.epoch !== signal.connection_epoch) {
      pair?.close('CONNECTION_LOST');
      pair = this.make(peer, signal.connection_epoch);
      const pending = this.pending.get(peer.id);
      if (pending) {
        this.pending.delete(peer.id);
        clearTimeout(pending.timer);
        void pair.ready.then(pending.resolve, pending.reject);
      }
    }
    if (pair?.epoch === signal.connection_epoch) await pair.accept(signal);
  }

  membersChanged(members: Member[]): void {
    for (const pair of this.pairs.values()) {
      const peer = members.find((member) => member.id === pair.peer.id);
      if (!peer) continue;
      if (peer.instance !== pair.peer.instance) pair.close('CONNECTION_LOST');
      else pair.peer = peer;
    }
  }

  closePeer(id: string, reason: string): void {
    this.pairs.get(id)?.close(reason);
    this.rejectPending(id, reason);
  }

  private rejectPending(id: string, reason: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }

  private make(peer: Member, epoch: string): Pair {
    const pair = new Pair(peer, epoch, this.client, {
      ...this.events,
      close: (stopped, code) => {
        if (this.pairs.get(peer.id) === stopped) this.pairs.delete(peer.id);
        this.retired.add(stopped.epoch);
        if (this.retired.size > 64) this.retired.delete(this.retired.values().next().value!);
        this.events.close(stopped, code);
      },
    }, this.connect());
    this.pairs.set(peer.id, pair);
    return pair;
  }

  private offer(peer: Member): Pair {
    const pair = this.make(peer, randomId());
    void pair.offer().catch((error: unknown) => pair.close(
      error instanceof Error && error.message === 'SIGNAL_DISCONNECTED' ? error.message : 'DIRECT_CONNECTION_FAILED',
    ));
    return pair;
  }

  destroy(reason: string): void {
    this.destroyed = true;
    for (const pair of this.pairs.values()) pair.close(reason);
    for (const id of this.pending.keys()) this.rejectPending(id, reason);
  }
}

