import assert from 'node:assert/strict';
import test from 'node:test';
import { PROTOCOL, bytes, pairId, readSignal } from '../src/shared/room.ts';
import { HEADER_BYTES, PREFERRED_FRAME, TEXT_LIMIT, decodeControl, decodeFrame, encodeControl, encodeFrame,
  messageLimit, safeFilename, textTooLong } from '../src/browser/protocol.ts';
import type { Control } from '../src/browser/protocol.ts';

const a = '0f42658c-3128-4d23-a07e-038bef3520c2';
const b = '8f42658c-3128-4d23-a07e-038bef3520c2';

test('the binary layout keeps 64-bit offsets and validates reserved bytes', () => {
  const payload = new Uint8Array([1, 2, 3, 255]);
  const frame = encodeFrame(a, 5 * 1024 ** 3 + 1, payload);
  assert.equal(frame.byteLength, HEADER_BYTES + payload.length);
  assert.equal(Buffer.from(frame).subarray(0, 8).toString('hex'), '46524d3101010000');
  assert.equal(new DataView(frame).getBigUint64(24), 5368709121n);
  assert.deepEqual(decodeFrame(frame), { id: a, offset: 5368709121, payload });
  new DataView(frame).setUint32(40, 1);
  assert.throws(() => decodeFrame(frame), /INVALID_FRAME/);
});

test('control and files enforce byte and browser-safe integer bounds', () => {
  assert.equal(bytes('5368709120'), 5 * 1024 ** 3);
  assert.throws(() => bytes('9007199254740992'));
  assert.equal(messageLimit(Infinity), 16 * 1024);
  assert.equal(messageLimit(5000), 5000);
  assert.throws(() => messageLimit(48));
  assert.throws(() => encodeControl({ type: 'file.reject', transfer_id: a, code: '字'.repeat(18) }, 100));
  assert.throws(() => decodeControl('{"v":1,"type":"file.commit","transfer_id":"'+a+'","size_bytes":"0"}'));
  assert.equal(safeFilename('../a/危\u202efile.html'), '_a_危file.html');
});

test('text control preserves Unicode and whitespace and fits within one frame', () => {
  const message = { type: 'text.message', message_id: a, text: '  测试 🙂\nhttps://example.test/\n  ' } as const;
  const ack = { type: 'text.ack', message_id: a } as const;
  assert.deepEqual(decodeControl(encodeControl(message, PREFERRED_FRAME)), message);
  assert.deepEqual(decodeControl(encodeControl(ack, PREFERRED_FRAME)), ack);
  assert.throws(() => decodeControl(encodeControl({ ...message, text: '\n  ' }, PREFERRED_FRAME)), /BAD_REQUEST/);
  assert.throws(() => decodeControl(encodeControl({ ...ack, message_id: 'invalid' }, PREFERRED_FRAME)), /BAD_REQUEST/);
  const max = '字'.repeat(TEXT_LIMIT / 3);
  assert.equal(textTooLong(max), false);
  assert.equal(textTooLong(max + '字'), true);
  assert.equal(textTooLong('\\'.repeat(TEXT_LIMIT / 2 + 1)), true);
  assert.throws(() => decodeControl(encodeControl({ ...message, text: max + '字' }, PREFERRED_FRAME)), /TEXT_TOO_LONG/);

  const hello = { type: 'hello', protocol: PROTOCOL, modes: [] } satisfies Control;
  assert.deepEqual(decodeControl(encodeControl(hello, PREFERRED_FRAME)), hello);
  const withText = { ...hello, text: true } satisfies Control;
  assert.deepEqual(decodeControl(encodeControl(withText, PREFERRED_FRAME)), withText);
});

test('server parsing supplies a bounded signaling envelope and excludes a relay path', () => {
  const room_id = 'example';
  const signal = {
    v: 1, room_id, to: b, to_instance: a, pair_id: pairId(a, b), connection_epoch: b, seq: 4,
    type: 'rtc.ice', payload: { candidate: 'candidate:1 1 udp 1 1.2.3.4 1234 typ host' }, from: b,
  };
  assert.equal('from' in readSignal(signal, room_id, a), false);
  assert.throws(() => readSignal({ ...signal, payload: { candidate: 'candidate:1 1 udp 1 1.2.3.4 1234 typ relay' } }, room_id, a),
    /RELAY_NOT_ALLOWED/);
  assert.throws(() => readSignal({ ...signal, type: 'file.offer' }, room_id, a));
});

