import { parse, type HTMLElement } from 'node-html-parser';

/**
 * Детерминированный парсер статистики матча с сайта чемпионата (без LLM).
 *
 * Логика (порт идеи из n8n /game_fee, но без ИИ):
 *  1. На странице два блока статистики команд (по умолчанию .math-p-stat и .math-p-stat-2).
 *  2. В каждом блоке — таблица игроков; в шапке есть колонка минут (МИН / MIN).
 *  3. Игрок считается сыгравшим, если минут > 0.
 *
 * ВНИМАНИЕ: селекторы зависят от вёрстки сайта. Если структура отличается —
 * поправь DEFAULT_TEAM_SELECTORS / эвристику поиска колонки минут.
 */

const DEFAULT_TEAM_SELECTORS = ['.math-p-stat', '.math-p-stat-2'];
const MINUTES_HEADER_RE = /^\s*(мин|min)\.?\s*$/i;

export interface ParsedPlayer {
  name: string;
  minutes: number;
}

export interface ParsedTeam {
  name: string;
  players: ParsedPlayer[];
}

export interface ParsedGame {
  teams: ParsedTeam[];
}

function textOf(el: HTMLElement | null | undefined): string {
  return (el?.text ?? '').replace(/\s+/g, ' ').trim();
}

function toNumber(s: string): number {
  const cleaned = s.replace(',', '.').replace(/[^\d.]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Найти индекс колонки минут по тексту шапки таблицы. */
function findMinutesColumn(table: HTMLElement): number {
  const headerCells = table.querySelectorAll('thead th, thead td, tr:first-child th');
  for (let i = 0; i < headerCells.length; i++) {
    if (MINUTES_HEADER_RE.test(textOf(headerCells[i]))) return i;
  }
  return -1;
}

function parseTeamBlock(block: HTMLElement): ParsedTeam {
  // Название команды — заголовок внутри блока, иначе data-атрибут/первый текст.
  const title =
    textOf(block.querySelector('h1,h2,h3,h4,.team-name,.math-p-stat-title')) ||
    block.getAttribute('data-team') ||
    '';

  const table = block.querySelector('table') ?? block;
  const minutesCol = findMinutesColumn(table);

  const rows = table.querySelectorAll('tbody tr, tr');
  const players: ParsedPlayer[] = [];

  for (const row of rows) {
    const cells = row.querySelectorAll('td');
    if (cells.length === 0) continue;

    const name = textOf(cells[0]);
    if (!name || MINUTES_HEADER_RE.test(name)) continue;

    // Минуты: из найденной колонки, иначе — последняя числовая ячейка как фолбэк.
    let minutes = 0;
    if (minutesCol >= 0 && minutesCol < cells.length) {
      minutes = toNumber(textOf(cells[minutesCol]));
    } else {
      const nums = cells.slice(1).map((c) => toNumber(textOf(c)));
      minutes = nums.find((n) => n > 0) ?? 0;
    }
    players.push({ name, minutes });
  }

  return { name: title, players };
}

export async function fetchGameStats(
  url: string,
  selectors: string[] = DEFAULT_TEAM_SELECTORS,
): Promise<ParsedGame> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'basketballgod/1.0 (+stats parser)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Не удалось загрузить статистику (${res.status}) по ${url}`);
  }
  const html = await res.text();
  const root = parse(html);

  const teams: ParsedTeam[] = [];
  for (const sel of selectors) {
    const block = root.querySelector(sel);
    if (block) teams.push(parseTeamBlock(block));
  }
  if (teams.length === 0) {
    throw new Error(
      `На странице не найдены блоки статистики (${selectors.join(', ')}). Проверь вёрстку сайта.`,
    );
  }
  return { teams };
}

/** Выбрать «нашу» команду по ключевому слову и вернуть сыгравших. */
export function pickOurPlayers(
  game: ParsedGame,
  keyword: string,
): { teamName: string; played: ParsedPlayer[] } | null {
  const kw = keyword.toLowerCase();
  const our =
    game.teams.find((t) => t.name.toLowerCase().includes(kw)) ?? game.teams[0];
  if (!our) return null;
  const played = our.players.filter((p) => p.minutes > 0);
  return { teamName: our.name, played };
}
