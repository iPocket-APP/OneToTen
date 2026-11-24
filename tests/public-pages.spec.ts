import { expect, test } from '@playwright/test';
import { locales, pagePath } from '../src/browser/locale.ts';

test('public pages have useful content and crawlable links with JavaScript disabled', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    expect((await page.goto('/'))?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('跨设备传文件');
    await expect(page.locator('.home-intro')).toContainText('iOS、Android、Windows、Linux 和 macOS');
    await expect(page.getByRole('button', { name: '创建房间' })).toBeDisabled();
    await page.getByRole('link', { name: 'AI Agent、CLI 和 MCP 使用向导' }).click();
    await expect(page).toHaveURL(/#agent-guide$/);
    const agentGuide = page.getByRole('region', { name: 'AI Agent、CLI 和 MCP 使用向导' });
    await expect(agentGuide.getByRole('heading', { name: '手机发给 Agent' })).toBeVisible();
    await expect(agentGuide.getByText('npm run build:agent', { exact: false })).toBeVisible();
    await agentGuide.getByText('CLI 快速开始', { exact: true }).click();
    await expect(agentGuide.getByText('npm run cli -- send', { exact: false })).toBeVisible();
    await agentGuide.getByText('MCP 接入 Agent', { exact: true }).click();
    await expect(agentGuide.getByText('codex mcp add file-room', { exact: false })).toBeVisible();
    const homeTitle = await page.title();
    await page.getByRole('link', { name: '查看使用指南和连接排查' }).click();
    await expect(page).toHaveURL(/\/guide$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('浏览器文件传输使用指南');
    await expect(page.locator('.home-intro')).toContainText('iOS、Android、Windows、Linux 和 macOS');
    expect(await page.title()).not.toBe(homeTitle);
    await page.getByRole('link', { name: '打开传文件工具' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('跨设备传文件');
  } finally {
    await context.close();
  }
});

test('the home agent guide copies commands for the current origin on a narrow screen', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (text: string) => { document.body.dataset.copiedCommand = text; } },
  }));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  await expect(page.getByRole('button', { name: '创建房间' })).toBeEnabled();
  await page.getByRole('link', { name: 'AI Agent、CLI 和 MCP 使用向导' }).click();
  const guide = page.getByRole('region', { name: 'AI Agent、CLI 和 MCP 使用向导' });
  await guide.getByText('CLI 快速开始', { exact: true }).click();
  await guide.getByText('MCP 接入 Agent', { exact: true }).click();
  const mcp = guide.locator('pre[aria-label="注册 Codex MCP命令"] code');
  await expect(mcp).toContainText("--server '" + new URL(baseURL!).origin + "'");
  await guide.getByRole('button', { name: '复制注册 Codex MCP命令' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-copied-command', (await mcp.textContent())!);
  await expect(guide.getByRole('status').filter({ hasText: '已复制' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);

  await page.goto('/join/' + 'A'.repeat(22) + '#invite=' + 'A'.repeat(43));
  await expect(page.getByRole('heading', { name: '加入房间', level: 1 })).toBeVisible();
  await expect(guide).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the sitemap and canonical URLs agree with the configured public origin', async ({ page, request }) => {
  await page.goto('/');
  const robots = await request.get('/robots.txt');
  expect(robots.ok()).toBe(true);
  expect(robots.headers()['content-type']).toMatch(/^text\/plain/);
  const rules = await robots.text();
  expect(rules).toContain('User-agent: *');
  expect(rules).toContain('Allow: /');
  const canonical = page.locator('link[rel="canonical"]');
  const origin = process.env.FILE_ROOM_SITE_URL;
  if (origin) await expect(canonical).toHaveAttribute('href', new URL('/', origin).href);

  const sitemap = await request.get('/sitemap.xml');
  if (await canonical.count() === 0) {
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    expect(rules).not.toContain('Sitemap:');
    expect(sitemap.status()).toBe(404);
    return;
  }

  const home = (await canonical.getAttribute('href'))!;
  const guide = new URL('/guide', home).href;
  expect(rules).toContain('Sitemap: ' + new URL('/sitemap.xml', home).href);
  expect(sitemap.ok()).toBe(true);
  expect(sitemap.headers()['content-type']).toMatch(/\/xml/);
  const urls = Array.from((await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1]);
  expect(urls.sort()).toEqual(locales.flatMap((locale) => [new URL(pagePath(locale), home).href,
    new URL(pagePath(locale, 'guide'), home).href]).sort());
  const site = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!);
  expect(site).toMatchObject({ '@type': 'WebSite', name: '一传十', url: home });
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', new URL('/share-card.jpg', home).href);

  await page.goto('/guide');
  await expect(canonical).toHaveAttribute('href', guide);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);

  await page.goto('/ar/guide');
  await expect(canonical).toHaveAttribute('href', new URL('/ar/guide', home).href);
  await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(13);
  await expect(page.locator('link[hreflang="en"]')).toHaveAttribute('href', new URL('/en/guide', home).href);
  await expect(page.locator('link[hreflang="x-default"]')).toHaveAttribute('href', guide);
});

test('private room routes stay out of the index and unknown paths return 404', async ({ request }) => {
  const headers = { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' };
  const id = 'AAAAAAAAAAAAAAAAAAAAAA';
  for (const path of ['/join/' + id, '/room/' + id]) {
    const response = await request.get(path, { headers });
    expect(response.status()).toBe(200);
    expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow');
    expect(response.headers()['cache-control']).toBe('private, no-store');
    const html = await response.text();
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).not.toContain('rel="canonical"');
  }
  for (const path of ['/missing-page', '/join/invalid', '/room/invalid', '/assets/missing.js']) {
    expect((await request.get(path, { headers })).status()).toBe(404);
  }
});
