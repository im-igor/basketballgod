import assert from 'node:assert/strict';
import test from 'node:test';
import type { Api } from 'grammy';
import { createTelegramHealthCheck } from './telegramHealth.service.js';

const apiWith = (getMe: (signal?: AbortSignal) => Promise<unknown>) => ({ getMe }) as Pick<Api, 'getMe'>;

test('параллельные проверки и свежий кэш используют один запрос, а force обновляет статус', async () => {
  let calls = 0;
  let resolve!: (result: unknown) => void;
  const check = createTelegramHealthCheck(apiWith(async () => {
    calls++;
    if (calls > 1) return { id: 1, is_bot: true };
    return new Promise(r => { resolve = r; });
  }));
  const first = check();
  const second = check();
  assert.equal(calls, 1);
  resolve({ id: 1, is_bot: true });
  const result = await first;
  assert.equal(result.available, true);
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.ok(result.latencyMs >= 0);
  assert.deepEqual(await second, result);
  assert.deepEqual(await check(), result);
  assert.equal(calls, 1);
  assert.equal((await check(true)).available, true);
  assert.equal(calls, 2);
});

test('ошибка не раскрывает детали подключения, следующая проверка видит восстановление', async () => {
  let calls = 0;
  const check = createTelegramHealthCheck(apiWith(async () => {
    if (++calls === 1) throw new Error('sensitive API connection details');
    return { id: 1 };
  }), { cacheMs: 0 });
  const failed = await check();
  assert.equal(failed.available, false);
  assert.doesNotMatch(JSON.stringify(failed), /sensitive/);
  assert.equal((await check()).available, true);
});

test('зависший запрос ограничен таймаутом и получает сигнал отмены', async () => {
  let signal: AbortSignal | undefined;
  const check = createTelegramHealthCheck(apiWith(async s => {
    signal = s;
    return new Promise(() => {});
  }), { timeoutMs: 10 });
  assert.equal((await check()).available, false);
  assert.equal(signal?.aborted, true);
});
