import assert from 'node:assert/strict';
import test from 'node:test';
import { layout } from './views.js';

test('верхнее меню ведёт по основному процессу, а периодические действия убраны в управление', () => {
  const html = layout('Расчеты — бюджет', '');
  const schedule = html.indexOf('href="/schedule"');
  const games = html.indexOf('href="/games"');
  const collections = html.indexOf('href="/collections"');
  const management = html.indexOf('aria-label="Управление"');
  const players = html.indexOf('href="/players"');
  const extraFees = html.indexOf('href="/extra-fees"');
  const tariffs = html.indexOf('href="/tariffs"');
  const tags = html.indexOf('href="/tags"');
  const cron = html.indexOf('href="/cron"');
  const backups = html.indexOf('href="/backups"');

  assert.ok(schedule < games && games < collections && collections < management);
  assert.ok(management < players && players < extraFees && extraFees < tariffs && tariffs < tags && tags < cron && cron < backups);
  assert.match(html, /<span class="step-number">1<\/span>Расписание/);
  assert.match(html, /<span class="step-number">2<\/span>Игры/);
  assert.doesNotMatch(html, /href="\/budgets"/);
  assert.match(html, /<span class="step-number">4<\/span>Расчеты/);
  assert.match(html, /href="\/collections" aria-current="page"/);
  assert.doesNotMatch(html, /class="nav-menu" open/);
});

test('страница сбора отмечает четвёртый раздел активным', () => {
  const html = layout('Расчеты октября', '');
  assert.match(html, /href="\/collections" aria-current="page"/);
  assert.doesNotMatch(html, /href="\/budgets" aria-current="page"/);
});

test('раздел из меню управления раскрывает его и отмечается активным', () => {
  const html = layout('Разовые сборы', '');
  assert.match(html, /class="nav-menu" open/);
  assert.match(html, /<summary aria-label="Управление" aria-current="page">/);
  assert.match(html, /href="\/extra-fees" aria-current="page"/);
  assert.match(html, /action="\/sync\/push"/);
});
