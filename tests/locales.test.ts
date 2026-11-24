import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locales } from '../src/browser/locale.ts';
import zhCN from '../src/browser/locales/zh-CN.ts';
import type { Messages } from '../src/browser/locales/zh-CN.ts';

const slots = (text: string) => Array.from(text.matchAll(/\{(\w+)\}/g), (match) => match[1]).sort();

test('all language catalogs cover the same messages and interpolation slots', async () => {
  assert.equal(locales.length, 12);
  for (const locale of locales) {
    const { default: messages } = await import('../src/browser/locales/' + locale + '.ts') as { default: Messages };
    for (const group of ['text', 'phases', 'errors'] as const) {
      const original: Record<string, string> = zhCN[group];
      const translated: Record<string, string> = messages[group];
      assert.deepEqual(Object.keys(translated).sort(), Object.keys(original).sort(), `${locale}/${group}`);
      for (const [key, message] of Object.entries(original)) {
        assert.ok(translated[key].trim(), `${locale}/${group}/${key} is empty`);
        assert.deepEqual(slots(translated[key]), slots(message), `${locale}/${group}/${key} has different slots`);
      }
    }
  }
});
