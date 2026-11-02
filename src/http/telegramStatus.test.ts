import '../test/env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { Bot } from 'grammy';
import { buildServer } from './server.js';
import { layout } from './views.js';
import { TELEGRAM_STATUS_SCRIPT } from './telegramStatus.js';

test('проверка Telegram доступна только администратору и не кэшируется браузером', async () => {
  let calls = 0;
  const app = await buildServer({ api: { getMe: async () => { calls++; return { id: 1 }; } } } as unknown as Bot);
  try {
    const denied = await app.inject('/api/telegram-status');
    assert.equal(denied.statusCode, 302);
    assert.equal(denied.headers.location, '/login');
    assert.equal(calls, 0);
    const login = await app.inject({ method: 'POST', url: '/login', payload: { username: 'test', password: 'test-password' } });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]!;
    const response = await app.inject({ url: '/api/telegram-status', headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json().available, true);
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test('индикатор есть в общем layout, но отсутствует на странице входа', () => {
  assert.match(layout('Расписание', ''), /id="telegram-status"/);
  assert.doesNotMatch(layout('Вход', '', { nav: false }), /id="telegram-status"|fetch\('\/api\/telegram-status'/);
});

test('индикатор обновляет доступность и сбрасывает зелёный статус при сбое админки', async () => {
  const title = { textContent: '' };
  const detail = { textContent: '' };
  const indicator = { dataset: { state: 'unknown' }, querySelector: (selector: string) => selector === '[data-telegram-title]' ? title : detail };
  const timers = new Map<number, () => Promise<void>>();
  let result: unknown = { available: true, checkedAt: new Date().toISOString(), latencyMs: 42 };
  runInNewContext(TELEGRAM_STATUS_SCRIPT, {
    AbortController,
    document: { hidden: false, getElementById: () => indicator, addEventListener: () => {} },
    setTimeout: (fn: () => Promise<void>, ms: number) => { timers.set(ms, fn); return ms; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string) => {
      assert.equal(url, '/api/telegram-status');
      if (result instanceof Error) throw result;
      return { ok: true, json: async () => result };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(indicator.dataset.state, 'available');
  assert.match(detail.textContent, /42 мс/);
  result = { available: false, checkedAt: new Date().toISOString(), latencyMs: 5000 };
  await timers.get(30000)!();
  assert.equal(indicator.dataset.state, 'unavailable');
  result = new Error('Admin server offline');
  await timers.get(30000)!();
  assert.equal(indicator.dataset.state, 'unknown');
  assert.match(title.textContent, /статус неизвестен/);
});
