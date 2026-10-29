import '../test/env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { publicationBlockReasons,publicationErrorMessage } from './publicationError.js';
import { GameStatsNotReadyError } from '../services/automaticGameStats.service.js';
import type { Budget } from '../db/types.js';
import { layout } from './views.js';

test('блокировка отправки объясняет отсутствие статистики и следующий шаг', () => {
  const message=publicationErrorMessage(new GameStatsNotReadyError(['01.11.2026 RED vs Ланит: матч ещё не завершился']));
  assert.match(message,/Отправка сбора заблокирована/);
  assert.match(message,/Базовый черновик сохранён/);
  assert.match(message,/пересобери бюджет/);
  assert.match(message,/Ланит/);
  assert.match(layout('Бюджет','',{flash:message}),/class="flash flash-error" role="alert"/);
});

test('причины выключенной публикации содержат корректировки и статистику', () => {
  const budget={team:'RED',details:{game_stats_warnings:['Нет протокола'],correction:{reviewed:false}}} as Budget;
  const reasons=publicationBlockReasons([budget],false);
  assert.equal(reasons.length,2);
  assert.match(reasons.join(' '),/Подтвердить корректировки/);
  assert.match(reasons.join(' '),/Игры/);
  assert.match(publicationErrorMessage(new Error('Календарь изменился. Пересобери бюджет')),/Календарь изменился/);
});
