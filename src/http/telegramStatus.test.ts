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
    await app.inject({ url: '/api/telegram-status', headers: { cookie } });
    assert.equal(calls, 1);
    await app.inject({ url: '/api/telegram-status?refresh=1', headers: { cookie } });
    assert.equal(calls, 2);
  } finally {
    await app.close();
  }
});

test('индикатор есть в общем layout, но отсутствует на странице входа', () => {
  assert.match(layout('Расписание', ''), /id="telegram-status"/);
  assert.doesNotMatch(layout('Вход', '', { nav: false }), /id="telegram-status"|fetch\('\/api\/telegram-status'/);
});

test('индикатор проверяет при открытии и повторно только по нажатию', async () => {
  let click!: () => void;
  const attributes = new Map<string, string>();
  const indicator = {
    dataset: { state: 'unknown' },
    title: '',
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    addEventListener: (name: string, handler: () => void) => { if (name === 'click') click = handler; },
  };
  const urls: string[] = [];
  let result: unknown = { available: true, checkedAt: new Date().toISOString(), latencyMs: 42 };
  runInNewContext(TELEGRAM_STATUS_SCRIPT, {
    AbortController,
    document: { getElementById: () => indicator },
    setTimeout: () => 1,
    clearTimeout: () => {},
    fetch: async (url: string) => {
      urls.push(url);
      if (result instanceof Error) throw result;
      return { ok: true, json: async () => result };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(urls, ['/api/telegram-status']);
  assert.equal(indicator.dataset.state, 'available');
  assert.match(indicator.title, /42 мс/);
  result = { available: false, checkedAt: new Date().toISOString(), latencyMs: 5000 };
  click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(urls, ['/api/telegram-status', '/api/telegram-status?refresh=1']);
  assert.equal(indicator.dataset.state, 'unavailable');
  result = new Error('Admin server offline');
  click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(indicator.dataset.state, 'unknown');
  assert.match(attributes.get('aria-label') ?? '', /статус неизвестен/);
  assert.doesNotMatch(TELEGRAM_STATUS_SCRIPT, /setTimeout\(check|visibilitychange/);
});
