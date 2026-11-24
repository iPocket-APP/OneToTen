import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { Session } from '../src/shared/room.ts';

export async function host(page: Page, url: string, name = 'Mac') {
  await page.goto(url);
  await page.getByLabel('设备名称').fill(name);
  await page.getByRole('button', { name: '创建房间' }).click();
  await expect(page.getByText('房间在线')).toBeVisible();
  await expect(page.getByAltText('入房二维码')).toBeVisible();
  const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem('file-room:' + location.pathname.split('/').pop())!) as Session);
  return { session, invitation: new URL('/join/' + session.roomId + '#invite=' + session.invite!.secret, url).href };
}

export async function join(page: Page, invitation: string, name: string) {
  await page.goto(invitation);
  await expect(page).toHaveURL(/\/room\/[^/#]+$/);
  await page.getByLabel('设备名称').fill(name);
  await page.getByRole('button', { name: '加入房间' }).click();
  await expect(page.getByText('房间在线')).toBeVisible();
}

export function record(page: Page, direction: 'send' | 'receive', file: string) {
  return page.locator('[data-direction="' + direction + '"]').filter({ hasText: file });
}

export async function stage(sender: Page, receiver: string, files: Parameters<Locator['setInputFiles']>[0]) {
  await sender.getByRole('button', { name: '选择 ' + receiver, exact: true }).click();
  await sender.locator('input[type="file"]').setInputFiles(files);
  await sender.getByRole('button', { name: '发送给 ' + receiver }).click();
}

export async function exportFile(page: Page, file: string, digest: string) {
  const item = record(page, 'receive', file);
  await expect(item).toHaveAttribute('data-phase', 'stored', { timeout: 35_000 });
  await item.getByRole('button', { name: '导出文件' }).click();
  const details = page.getByRole('dialog', { name: '文件详情' });
  await expect(details.getByRole('heading', { name: file, exact: true })).toBeVisible();
  const link = details.getByRole('link', { name: '下载' });
  await expect(link).toBeVisible();
  const [result] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), link.click()]);
  expect(result.suggestedFilename()).toBe(file);
  expect(hash(await readFile((await result.path())!))).toBe(digest);
  await details.getByRole('button', { name: '关闭', exact: true }).click();
}

export const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
