import { writeFile } from 'node:fs/promises';
import { test, expect, devices, webkit } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { exportFile, hash, host, join, record, stage } from './browser-room.ts';

async function interruptOnce(context: BrowserContext, after: number) {
  await context.addInitScript((limit) => {
    const connections: RTCPeerConnection[] = [];
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) { super(config); connections.push(this); }
    };
    const send = RTCDataChannel.prototype.send;
    let remaining = limit;
    let interrupted = false;
    RTCDataChannel.prototype.send = function (this: RTCDataChannel, value: string | Blob | ArrayBuffer | ArrayBufferView) {
      if (this.label === 'bulk' && value instanceof ArrayBuffer && !interrupted) {
        remaining -= value.byteLength;
        if (remaining <= 0) {
          interrupted = true;
          for (const connection of connections) connection.close();
          throw new Error('CONNECTION_LOST');
        }
      }
      Reflect.apply(send, this, [value]);
    } as typeof send;
  }, after);
}

test('Mac invites Chromium and WebKit, then both phones send after Mac exits', async ({ browser, baseURL }, info) => {
  const hostContext = await browser.newContext();
  const androidContext = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  const iphoneContext = await webkit.launchPersistentContext(info.outputPath('webkit-profile'),
    { ...devices['iPhone 15'], locale: 'zh-CN', acceptDownloads: true });
  try {
    const mac = await hostContext.newPage();
    const android = await androidContext.newPage();
    const iphone = await iphoneContext.newPage();
    const { invitation } = await host(mac, baseURL!);
    await join(android, invitation, 'Android 端');
    await join(iphone, invitation, 'iPhone 端');
    await expect(mac.getByRole('button', { name: '选择 iPhone 端' })).toBeVisible();
    const data = Buffer.alloc(2 * 1024 ** 2 + 5, 'room transfer');
    await stage(android, 'iPhone 端', { name: '照片样本.bin', mimeType: 'application/octet-stream', buffer: data });
    const incoming = record(iphone, 'receive', '照片样本.bin');
    await expect(incoming).toHaveAttribute('data-phase', 'incoming', { timeout: 25_000 });
    await mac.close();
    await expect(iphone.getByRole('button', { name: '选择 Mac', exact: true })).toHaveCount(0);
    await incoming.getByRole('button', { name: '接收并暂存' }).click();
    await exportFile(iphone, '照片样本.bin', hash(data));
    await expect(record(android, 'send', '照片样本.bin')).toHaveAttribute('data-phase', 'stored');

    await stage(iphone, 'Android 端', { name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) });
    await record(android, 'receive', 'empty.bin').getByRole('button', { name: '接收并暂存' }).click();
    await exportFile(android, 'empty.bin', hash(Buffer.alloc(0)));
    await expect(record(iphone, 'send', 'empty.bin')).toHaveAttribute('data-phase', 'stored');
  } finally {
    await Promise.all([hostContext.close(), androidContext.close(), iphoneContext.close()]);
  }
});

test('direct text reaches only the chosen device and can be copied or replied to', async ({ browser, baseURL }, info) => {
  const macContext = await browser.newContext();
  const observerContext = await browser.newContext();
  const iphoneContext = await webkit.launchPersistentContext(info.outputPath('text-webkit-profile'), { ...devices['iPhone 15'], locale: 'zh-CN' });
  try {
    const mac = await macContext.newPage();
    const iphone = await iphoneContext.newPage();
    const observer = await observerContext.newPage();
    const { invitation } = await host(mac, baseURL!);
    await join(iphone, invitation, 'iPhone 端');
    await join(observer, invitation, '另一台设备');
    await expect(mac.getByRole('button', { name: '选择 另一台设备' })).toBeVisible();

    const message = '  中英文 🙂\nhttps://example.test/?a=1&b=2\n<img src=x>\n';
    const draft = mac.getByRole('textbox', { name: '要发送的文字' });
    const send = mac.getByRole('button', { name: /^发送(?:给 iPhone 端)?$/ });
    await draft.fill(message);
    await expect(send).toBeDisabled();
    await mac.getByRole('button', { name: '选择 iPhone 端' }).click();
    await draft.fill('字'.repeat(5000));
    await expect(send).toBeDisabled();
    await expect(mac.getByText('这段文字太长，请分几次发送。')).toBeVisible();
    await draft.fill('第一行');
    await draft.press('End');
    await draft.press('Shift+Enter');
    await expect(draft).toHaveValue('第一行\n');
    await draft.fill(message);
    await draft.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(draft).toBeEditable();
    await draft.press('Enter');

    const received = iphone.locator('[data-text-direction="receive"]');
    await expect(received).toContainText('来自 Mac');
    await expect(received.locator('.text-transfer-content')).toHaveJSProperty('textContent', message);
    await expect(received.locator('img')).toHaveCount(0);
    await expect(mac.getByText('iPhone 端 已接收文字。')).toBeVisible();
    await expect(draft).toHaveValue('');
    await expect(observer.locator('[data-text-direction]')).toHaveCount(0);

    // Capture the browser's text selection or clipboard write without changing the host pasteboard.
    await iphone.evaluate(() => {
      const capture = (value: string) => { document.body.dataset.copied = value; };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText = async (value) => capture(value);
      } else {
        document.execCommand = (command) => {
          const field = document.activeElement;
          if (command !== 'copy' || !(field instanceof HTMLTextAreaElement)) return false;
          capture(field.value.slice(field.selectionStart, field.selectionEnd));
          return true;
        };
      }
    });
    await received.getByRole('button', { name: '复制文字' }).click();
    await expect(received.getByText('已复制')).toBeVisible();
    expect(await iphone.evaluate(() => document.body.dataset.copied)).toBe(message);
    await iphone.evaluate(() => {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText = async () => { throw new Error('Denied'); };
      document.execCommand = () => false;
    });
    await received.getByRole('button', { name: '复制文字' }).click();
    await expect(received.getByText('请手动复制这段文字。')).toBeVisible();
    expect(await iphone.evaluate(() => window.getSelection()?.getRangeAt(0).toString())).toBe(message);

    await iphone.getByRole('button', { name: '选择 Mac', exact: true }).click();
    await iphone.getByRole('textbox', { name: '要发送的文字' }).fill('收到啦 ✅');
    await iphone.getByRole('button', { name: '发送给 Mac', exact: true }).click();
    await expect(mac.locator('[data-text-direction="receive"]')).toContainText('收到啦 ✅');
    await expect(iphone.locator('[data-text-direction="send"]')).toContainText('对方已接收');
    await expect(observer.locator('[data-text-direction]')).toHaveCount(0);
  } finally {
    await Promise.all([macContext.close(), iphoneContext.close(), observerContext.close()]);
  }
});

test('one send delivers text and an attachment, and a lost text receipt retries without duplicates', async ({ browser, baseURL }) => {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  await receiverContext.addInitScript(() => {
    const send = RTCDataChannel.prototype.send;
    let dropReceipt = true;
    RTCDataChannel.prototype.send = function (this: RTCDataChannel, value: string | Blob | ArrayBuffer | ArrayBufferView) {
      if (dropReceipt && typeof value === 'string' && value.includes('"type":"text.ack"')) {
        dropReceipt = false;
        return;
      }
      Reflect.apply(send, this, [value]);
    } as typeof send;
  });
  try {
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    const { invitation } = await host(sender, baseURL!);
    await join(receiver, invitation, '接收端');
    const draft = sender.getByRole('textbox', { name: '要发送的文字' });
    const send = sender.getByRole('button', { name: '发送给 接收端', exact: true });
    const attachments = sender.getByRole('list', { name: '附件', exact: true });
    const file = { name: '随附文件.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment from the same send') };
    const message = '等待接收确认';
    await draft.fill(message);
    await sender.locator('input[type="file"]').setInputFiles(file);
    const dropped = await sender.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['remove me'], '拖入后移除.txt', { type: 'text/plain' }));
      return transfer;
    });
    const composer = sender.locator('.send-composer');
    await composer.dispatchEvent('dragover', { dataTransfer: dropped });
    await expect(composer).toHaveClass(/dragging/);
    await composer.dispatchEvent('drop', { dataTransfer: dropped });
    await dropped.dispose();
    await expect(attachments.getByRole('listitem')).toHaveCount(2);
    await attachments.getByRole('button', { name: '移除 拖入后移除.txt' }).click();
    await expect(attachments.getByRole('listitem')).toHaveCount(1);
    await send.click();
    const received = receiver.locator('[data-text-direction="receive"]');
    await expect(received).toContainText(message);
    const attachment = record(receiver, 'receive', file.name);
    await expect(attachment).toHaveAttribute('data-phase', 'incoming');
    await attachment.getByRole('button', { name: '接收并暂存' }).click();
    await exportFile(receiver, file.name, hash(file.buffer));
    await expect(sender.getByText('附件已排队。未收到对方的接收确认，请重试。')).toBeVisible({ timeout: 25_000 });
    await expect(draft).toHaveValue(message);
    await expect(attachments).toHaveCount(0);
    await send.click();
    await expect(sender.getByText('接收端 已接收文字。')).toBeVisible();
    await expect(received).toHaveCount(1);
    await expect(attachment).toHaveCount(1);
    await expect(record(sender, 'send', file.name)).toHaveCount(1);
    await expect(draft).toHaveValue('');
  } finally {
    await Promise.all([senderContext.close(), receiverContext.close()]);
  }
});

test('a member can rename their own device during a transfer and keep the name after reloading', async ({ browser, request, baseURL }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const mac = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const { session, invitation } = await host(mac, baseURL!);
    await join(guest, invitation, '访客');
    const endpoint = '/api/v1/rooms/' + session.roomId + '/members/self';
    expect((await request.patch(endpoint, { data: { name: '无凭证' } })).status()).toBe(401);
    expect((await request.patch(endpoint, {
      headers: { Authorization: 'Bearer ' + session.token }, data: { name: '  ' },
    })).status()).toBe(400);

    const file = { name: '改名中的传输.txt', mimeType: 'text/plain', buffer: Buffer.from('rename without reconnecting') };
    await stage(mac, '访客', file);
    const incoming = record(guest, 'receive', file.name);
    await expect(incoming).toHaveAttribute('data-phase', 'incoming');
    await guest.getByRole('button', { name: '修改本机名称', exact: true }).click();
    const dialog = guest.getByRole('dialog', { name: '修改本机名称' });
    const field = dialog.getByRole('textbox', { name: '设备名称' });
    const save = dialog.getByRole('button', { name: '保存', exact: true });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('访客');
    await expect(save).toBeDisabled();
    await field.fill('  随身手机  ');
    await save.click();
    await expect(dialog).toHaveCount(0);
    await expect(guest.locator('.device.self')).toContainText('随身手机');
    await expect(mac.getByRole('button', { name: '选择 随身手机', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(mac.getByRole('button', { name: '选择 访客', exact: true })).toHaveCount(0);
    await incoming.getByRole('button', { name: '接收并暂存' }).click();
    await exportFile(guest, file.name, hash(file.buffer));
    await expect(record(mac, 'send', file.name)).toHaveAttribute('data-phase', 'stored');

    await guest.getByRole('textbox', { name: '要发送的文字' }).fill('改名后继续');
    await guest.getByRole('button', { name: '发送给 Mac', exact: true }).click();
    const received = mac.locator('[data-text-direction="receive"]');
    await expect(received).toContainText('来自 随身手机');
    await expect(received).toContainText('改名后继续');
    await guest.reload();
    await expect(guest.getByText('房间在线')).toBeVisible();
    await expect(guest.locator('.device.self')).toContainText('随身手机');
    await expect(mac.getByRole('button', { name: '选择 随身手机', exact: true })).toBeVisible();
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});

test('receiving shows live progress and each verified file opens its own completion details', async ({ browser, baseURL }) => {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  type TestReceiver = typeof window & { heldReceive?: Map<string, () => void> };
  await receiverContext.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    const pauseOnce = new Set(['receive.write', 'receive.commit']);
    const held = new Map<string, () => void>();
    (window as TestReceiver).heldReceive = held;
    Worker.prototype.postMessage = function (this: Worker, message: { type: string }, ...args: unknown[]) {
      const send = () => Reflect.apply(post, this, [message, ...args]);
      if (pauseOnce.delete(message.type)) held.set(message.type, send);
      else send();
    } as typeof post;
  });
  try {
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    const { invitation } = await host(sender, baseURL!, '设计台');
    await join(receiver, invitation, '收件端');
    const first = { name: '交接说明.txt', mimeType: 'text/plain', buffer: Buffer.from('first receipt') };
    const second = { ...first, name: '项目清单.txt', buffer: Buffer.from('second receipt') };
    const toasts = receiver.getByRole('list', { name: '文件接收通知' });
    const toast = (name: string) => toasts.getByRole('button', { name: '查看文件详情 ' + name, exact: true });
    const active = receiver.getByRole('region', { name: '正在接收' });
    const progress = active.getByRole('progressbar', { name: '本机写入进度' });
    const release = async (step: string) => {
      await expect.poll(() => receiver.evaluate((key) => (window as TestReceiver).heldReceive?.has(key), step)).toBe(true);
      await receiver.evaluate((key) => (window as TestReceiver).heldReceive!.get(key)!(), step);
    };

    await stage(sender, '收件端', [first, second]);
    await record(receiver, 'receive', first.name).getByRole('button', { name: '接收并暂存' }).click();
    await expect(record(receiver, 'receive', first.name)).toHaveAttribute('data-phase', 'transferring');
    await expect(progress).toHaveJSProperty('value', 0);
    await expect(toast(first.name)).toHaveCount(0);
    await release('receive.write');
    await expect(active.getByText('正在校验', { exact: true })).toBeVisible();
    await expect(progress).toHaveJSProperty('value', first.buffer.length);
    await expect(toast(first.name)).toHaveCount(0);
    await release('receive.commit');
    await expect(toast(first.name)).toBeVisible();
    await expect(sender.getByRole('button', { name: '查看文件详情 ' + first.name })).toHaveCount(0);

    await record(receiver, 'receive', second.name).getByRole('button', { name: '接收并暂存' }).click();
    await expect(toast(second.name)).toBeVisible();
    await toast(first.name).click();
    const details = receiver.getByRole('dialog', { name: '文件详情' });
    await expect(details.getByRole('heading', { name: first.name, exact: true })).toBeVisible();
    await expect(details.getByText('设计台', { exact: true })).toBeVisible();
    await expect(details.getByText('已校验并暂存', { exact: true })).toBeVisible();
    await expect(details.getByRole('link', { name: '下载' })).toHaveAttribute('download', first.name);
    await details.getByRole('button', { name: '关闭', exact: true }).click();
    await toasts.getByRole('button', { name: '关闭接收提示 ' + second.name }).click();
    await expect(toast(second.name)).toHaveCount(0);
    await exportFile(receiver, second.name, hash(second.buffer));

    await receiver.reload();
    await expect(record(receiver, 'receive', first.name)).toHaveAttribute('data-phase', 'stored');
    await expect(toasts.getByRole('listitem')).toHaveCount(0);
  } finally {
    await Promise.all([senderContext.close(), receiverContext.close()]);
  }
});

test('late join can claim an online share and reject or cancel a transfer', async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const mac = await context.newPage();
    const guest = await guestContext.newPage();
    const { invitation } = await host(mac, baseURL!);
    const file = { name: 'share.txt', mimeType: 'text/plain', buffer: Buffer.from('share') };
    await mac.locator('input[type="file"]').setInputFiles(file);
    await mac.getByRole('button', { name: '发布待领取' }).click();
    await mac.getByRole('dialog').getByRole('button', { name: '发布', exact: true }).click();
    await expect(mac.getByText('本机发布')).toBeVisible();
    await join(guest, invitation, '领取设备');
    await guest.getByRole('button', { name: '申请领取' }).click();
    await mac.getByRole('button', { name: '同意发送' }).click();
    await record(guest, 'receive', 'share.txt').getByRole('button', { name: '接收并暂存' }).click();
    await exportFile(guest, 'share.txt', hash(file.buffer));
    await expect(record(mac, 'send', 'share.txt')).toHaveAttribute('data-phase', 'stored');

    await stage(guest, 'Mac', { ...file, name: 'declined.txt' });
    await record(mac, 'receive', 'declined.txt').getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(record(guest, 'send', 'declined.txt')).toHaveAttribute('data-phase', 'rejected');

    await stage(mac, '领取设备', { ...file, name: 'cancelled.txt' });
    await expect(record(guest, 'receive', 'cancelled.txt')).toHaveAttribute('data-phase', 'incoming');
    await record(mac, 'send', 'cancelled.txt').getByRole('button', { name: '取消传输' }).click();
    await expect(record(guest, 'receive', 'cancelled.txt')).toHaveAttribute('data-phase', 'cancelled');

    await guest.getByRole('button', { name: '离开', exact: true }).click();
    await guest.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(guest.getByRole('heading', { name: '跨设备传文件' })).toBeVisible();
    await expect(mac.getByRole('button', { name: '选择 领取设备' })).toHaveCount(0);
  } finally {
    await Promise.all([context.close(), guestContext.close()]);
  }
});

test('after a broken connection, the receiver can reload and resume from a persisted checkpoint', async ({ browser, baseURL }, info) => {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  await interruptOnce(senderContext, 6 * 1024 ** 2);
  try {
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    const { invitation } = await host(sender, baseURL!);
    await join(receiver, invitation, '续传接收端');
    const file = 'resume-64MiB.bin';
    const local = info.outputPath(file);
    const data = Buffer.alloc(64 * 1024 ** 2, 'verify-checkpoint');
    await writeFile(local, data);
    await stage(sender, '续传接收端', local);
    await record(receiver, 'receive', file).getByRole('button', { name: '接收并暂存' }).click();
    await expect(record(sender, 'send', file)).toHaveAttribute('data-phase', 'paused');
    await receiver.reload();
    const reopened = record(receiver, 'receive', file);
    await expect(reopened).toHaveAttribute('data-phase', 'paused');
    await expect(reopened).toContainText(/已保留 [1-9][0-9.]* MiB/);
    await record(sender, 'send', file).getByRole('button', { name: '续传', exact: true }).click();
    await reopened.getByRole('button', { name: '确认续传' }).click();
    await exportFile(receiver, file, hash(data));
    await expect(record(sender, 'send', file)).toHaveAttribute('data-phase', 'stored');
  } finally {
    await Promise.all([senderContext.close(), receiverContext.close()]);
  }
});

test('LAN HTTP resumes an IndexedDB file beyond the memory limit and downloads the original bytes', async ({ browser, baseURL }, info) => {
  const address = new URL(baseURL!);
  test.skip(address.protocol !== 'http:' || ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname),
    'Run against an enabled LAN HTTP development address');
  test.setTimeout(150_000);
  const senderContext = await browser.newContext();
  const receiverContext = await webkit.launchPersistentContext(info.outputPath('lan-webkit-profile'),
    { ...devices['iPhone 15'], locale: 'zh-CN', acceptDownloads: true });
  await interruptOnce(senderContext, 12 * 1024 ** 2);
  try {
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    const { invitation } = await host(sender, baseURL!);
    await join(receiver, invitation, 'HTTP 接收端');
    expect(await receiver.evaluate(() => window.isSecureContext)).toBe(false);
    const file = 'lan-checkpoint.bin';
    const data = Buffer.alloc(40 * 1024 ** 2 + 259, 'http-checkpoint');
    const local = info.outputPath(file);
    await writeFile(local, data);
    await stage(sender, 'HTTP 接收端', local);
    const incoming = record(receiver, 'receive', file);
    await incoming.getByRole('button', { name: '接收并暂存' }).click();
    await expect(record(sender, 'send', file)).toHaveAttribute('data-phase', 'paused', { timeout: 35_000 });
    await receiver.reload();
    await expect(incoming).toContainText(/已保留 [1-9][0-9.]* MiB/);
    await record(sender, 'send', file).getByRole('button', { name: '续传', exact: true }).click();
    await incoming.getByRole('button', { name: '确认续传' }).click();
    await expect(incoming).toHaveAttribute('data-phase', 'stored', { timeout: 70_000 });
    await exportFile(receiver, file, hash(data));
    await expect(record(sender, 'send', file)).toHaveAttribute('data-phase', 'stored');
    await receiver.reload();
    await receiver.getByRole('button', { name: '接收的文件' }).click();
    await receiver.getByRole('button', { name: '准备下载' }).click();
    await expect(receiver.getByRole('link', { name: '下载' })).toHaveAttribute('download', file);
  } finally {
    await Promise.all([senderContext.close(), receiverContext.close()]);
  }
});

test('invitation rotation, member authorization, room capacity and explicit end', async ({ browser, request, baseURL }) => {
  const context = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const page = await context.newPage();
    const guest = await guestContext.newPage();
    const { session, invitation } = await host(page, baseURL!);
    const api = '/api/v1/rooms/' + session.roomId;
    const headers = { Authorization: 'Bearer ' + session.token };
    const denied = await request.post(api + '/invites/rotate', { headers });
    expect(denied.status()).toBe(401);
    const crossOrigin = await request.post('/api/v1/rooms', {
      headers: { Origin: 'https://other.example' }, data: { name: '外站', kind: 'desktop' },
    });
    expect(crossOrigin.status()).toBe(403);
    await page.getByRole('button', { name: '生成新邀请' }).click();
    await expect.poll(async () => await page.evaluate((id) =>
      JSON.parse(sessionStorage.getItem('file-room:' + id)!).invite.secret, session.roomId)).not.toBe(session.invite!.secret);
    await guest.goto(invitation);
    await guest.getByRole('button', { name: '加入房间' }).click();
    await expect(guest.getByRole('alert')).toContainText('邀请已失效');

    const secret = await page.evaluate((id) => JSON.parse(sessionStorage.getItem('file-room:' + id)!).invite.secret, session.roomId);
    await join(guest, new URL('/join/' + session.roomId + '#invite=' + secret, baseURL).href, '会被移出');
    for (let index = 0; index < 6; index++) {
      const booked = await request.post(api + '/join', { data: { name: '成员' + index, kind: 'other', invite: secret } });
      expect(booked.status()).toBe(201);
    }
    const full = await request.post(api + '/join', { data: { name: '超出容量', kind: 'other', invite: secret } });
    expect(full.status()).toBe(409);
    await page.getByRole('button', { name: '移出 会被移出' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(guest.getByRole('alert')).toContainText('资格已撤销');

    await page.getByRole('button', { name: '结束房间' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('heading', { name: '跨设备传文件' })).toBeVisible();
    expect((await request.get(api + '/session', { headers })).status()).toBe(410);
  } finally {
    await Promise.all([context.close(), guestContext.close()]);
  }
});

test('direct writer opens only after approval, and a cancelled picker keeps the offer pending', async ({ browser, baseURL }) => {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  await receiverContext.addInitScript(() => {
    let cancelled = false;
    Object.defineProperty(window, 'showSaveFilePicker', {
      async value({ suggestedName }: { suggestedName: string }) {
        if (!cancelled) {
          cancelled = true;
          throw new DOMException('Test picker closed', 'AbortError');
        }
        return (await navigator.storage.getDirectory()).getFileHandle('picker-' + suggestedName, { create: true });
      },
    });
  });
  try {
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    const { invitation } = await host(sender, baseURL!);
    await join(receiver, invitation, '保存设备');
    const raw = [Buffer.from([1]), Buffer.from('direct storage')];
    const inputs = raw.map((buffer, index) => ({ name: 'direct-' + index + '.bin', buffer, mimeType: 'application/octet-stream' }));
    await stage(sender, '保存设备', inputs);
    const initial = record(receiver, 'receive', inputs[0].name);
    await initial.getByRole('button', { name: '选择位置并接收' }).click();
    await expect(initial).toContainText('已关闭保存选择器');
    await expect(record(sender, 'send', inputs[0].name)).toHaveAttribute('data-phase', 'awaiting');
    await expect(receiver.getByRole('button', { name: '查看文件详情 ' + inputs[0].name })).toHaveCount(0);
    for (const [index, input] of inputs.entries()) {
      const row = record(receiver, 'receive', input.name);
      await row.getByRole('button', { name: '选择位置并接收' }).click();
      await expect(row).toHaveAttribute('data-phase', 'saved');
      await expect(record(sender, 'send', input.name)).toHaveAttribute('data-phase', 'saved');
      await receiver.getByRole('button', { name: '查看文件详情 ' + input.name, exact: true }).click();
      const details = receiver.getByRole('dialog', { name: '文件详情' });
      await expect(details.getByRole('heading', { name: input.name, exact: true })).toBeVisible();
      await expect(details.getByText('已保存到所选位置', { exact: true })).toBeVisible();
      await expect(details.getByRole('link', { name: '下载' })).toHaveCount(0);
      await details.getByRole('button', { name: '关闭', exact: true }).click();
      const downloaded = await receiver.evaluate(async (name) => {
        const directory = await navigator.storage.getDirectory();
        const file = await (await directory.getFileHandle('picker-' + name)).getFile();
        return [...new Uint8Array(await file.arrayBuffer())];
      }, input.name);
      expect(hash(Buffer.from(downloaded))).toBe(hash(raw[index]));
    }
  } finally {
    await Promise.all([senderContext.close(), receiverContext.close()]);
  }
});

