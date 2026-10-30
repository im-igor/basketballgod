import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { PAYOUT_LOADER_SCRIPT } from './payoutLoader.js';

function setup(fetch: (url: string) => Promise<unknown>, automatic = false) {
  let toggle!: () => Promise<void>;
  let retry!: () => Promise<void>;
  const content = { innerHTML: '', textContent: '', appendChild() {} };
  const details = { ...content, open: false, dataset: { payoutUrl: '/collections/11-2026/payout', ...(automatic ? { payoutAuto: '' } : {}) },
    querySelector: () => content,
    addEventListener: (_event: string, listener: typeof toggle) => { toggle = listener; } };
  runInNewContext(PAYOUT_LOADER_SCRIPT, { fetch, document: {
    querySelectorAll: () => [details],
    createElement: () => ({ type: '', textContent: '', addEventListener: (_event: string, listener: typeof retry) => { retry = listener; } }),
  } });
  return { details, content: automatic ? details : content, toggle: () => toggle(), retry: () => retry() };
}

test('начисления загружаются только при раскрытии и один раз при повторных нажатиях', async () => {
  let requests = 0;
  let resolve!: (value: unknown) => void;
  const response = new Promise(r => { resolve = r; });
  const s = setup(async url => { assert.equal(url, '/collections/11-2026/payout'); requests++; return response; });
  await s.toggle();
  assert.equal(requests, 0);
  s.details.open = true;
  const loading = s.toggle();
  assert.match(s.content.innerHTML, /Загружаю/);
  await s.toggle();
  assert.equal(requests, 1);
  resolve({ ok: true, redirected: false, text: async () => '<p>5000 ₽</p>' });
  await loading;
  assert.equal(s.content.innerHTML, '<p>5000 ₽</p>');
  s.details.open = false; await s.toggle();
  s.details.open = true; await s.toggle();
  assert.equal(requests, 1);
});

test('ошибка календаря показывает причину текстом и позволяет повторить запрос', async () => {
  let requests = 0;
  const s = setup(async () => {
    requests++;
    return { ok: requests > 1, redirected: false, text: async () => requests === 1 ? 'Календарь недоступен <test>' : '<p>Готово</p>' };
  });
  s.details.open = true;
  await s.toggle();
  assert.equal(s.content.textContent, 'Календарь недоступен <test>');
  await s.retry();
  assert.equal(s.content.innerHTML, '<p>Готово</p>');
  assert.equal(requests, 2);
});


test('суммы на карточке загружаются автоматически без раскрытия деталей', async () => {
  let requests = 0;
  const s = setup(async () => {
    requests++;
    return { ok: true, redirected: false, text: async () => '<div>Тренер 5000 ₽</div><details><summary>Расшифровка</summary></details>' };
  }, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(s.details.open, false);
  assert.match(s.content.innerHTML, /Тренер 5000 ₽/);
  assert.doesNotMatch(s.content.innerHTML, /<details open/);
});
