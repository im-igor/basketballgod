import assert from 'node:assert/strict';
import test from 'node:test';
import { layout } from './views.js';

test('верхнее меню ведёт по основному процессу, а периодические действия убраны в управление', () => {
  const html = layout('Бюджеты', '');
  const schedule = html.indexOf('href="/schedule"');
  const games = html.indexOf('href="/games"');
  const budgets = html.indexOf('href="/budgets"');
  const management = html.indexOf('aria-label="Управление"');
  const players = html.indexOf('href="/players"');
  const extraFees = html.indexOf('href="/extra-fees"');
  const tariffs = html.indexOf('href="/tariffs"');
  const tags = html.indexOf('href="/tags"');
  const cron = html.indexOf('href="/cron"');

  assert.ok(schedule < games && games < budgets && budgets < management);
  assert.ok(management < players && players < extraFees && extraFees < tariffs && tariffs < tags && tags < cron);
  assert.match(html, /<span class="step-number">1<\/span>Расписание/);
  assert.match(html, /<span class="step-number">2<\/span>Игры/);
  assert.match(html, /<span class="step-number">3<\/span>Бюджеты/);
  assert.match(html, /href="\/budgets" aria-current="page"/);
  assert.doesNotMatch(html, /class="nav-menu" open/);
});

test('раздел из меню управления раскрывает его и отмечается активным', () => {
  const html = layout('Разовые сборы', '');
  assert.match(html, /class="nav-menu" open/);
  assert.match(html, /<summary aria-label="Управление" aria-current="page">/);
  assert.match(html, /href="\/extra-fees" aria-current="page"/);
  assert.match(html, /action="\/sync\/push"/);
});
