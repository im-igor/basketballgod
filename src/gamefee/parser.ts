import { parse, type HTMLElement } from 'node-html-parser';

/**
 * Детерминированный парсер статистики матча с сайта чемпионата (без LLM).
 *
 * Реальная вёрстка businesschampions.ru (vesna-2026):
 *  - два блока-обёртки .math-p-stat и .math-p-stat-2, в каждом заголовок
 *    «Статистика команды <Название>» (.match-page--title) и таблица
 *    <table class="teams-page-2-table">;
 *  - в шапке есть колонка «Игрок» (имя) и «ВР» (время на паркете, формат «мм : сс»);
 *  - игрок считается сыгравшим, если время > 0;
 *  - строки «Всего»/«Тренер» — служебные, в игроки не идут.
 *
 * Парсер ищет колонки по тексту шапки, поэтому терпим к перестановке столбцов.
 * Если сайт сменит вёрстку — поправь регулярки заголовков ниже.
 */

const DEFAULT_TEAM_SELECTORS = ['.math-p-stat', '.math-p-stat-2'];
// Заголовки колонок: имя игрока и время на паркете (минуты).
const NAME_HEADER_RE = /(игрок|player|фамилия|name)/i;
const TIME_HEADER_RE = /^\s*(вр|время|мин\.?|min)\s*$/i;
// Служебные строки (итоги/тренер) — не игроки.
const NON_PLAYER_RE = /(всего|итого|команда|тренер|total|coach)/i;
const HAS_LETTER_RE = /[A-Za-zА-Яа-яЁё]/;

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

/** Минуты из ячейки: «26 : 33» → 26.55, «12» → 12, пусто/мусор → 0. */
function parseMinutes(s: string): number {
  const t = s.trim();
  const mmss = t.match(/^(\d{1,3})\s*:\s*(\d{1,2})$/);
  if (mmss) return Number(mmss[1]) + Number(mmss[2]) / 60;
  const n = Number.parseFloat(t.replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Индекс колонки по тексту заголовка, -1 если нет.
 * Учитываем `colspan`: первая ячейка шапки тут `<th colspan="2">`, поэтому позиция
 * заголовка не совпадает с номером ячейки в строках данных без поправки на span.
 */
function findColumn(table: HTMLElement, re: RegExp): number {
  const header = table.querySelector('thead tr') ?? table.querySelector('tr');
  if (!header) return -1;
  let col = 0;
  for (const cell of header.querySelectorAll('th, td')) {
    if (re.test(textOf(cell))) return col;
    col += Number(cell.getAttribute('colspan') ?? '1') || 1;
  }
  return -1;
}

/** Название команды из заголовка блока: «Статистика команды Yandex Black» → «Yandex Black». */
function teamTitle(block: HTMLElement): string {
  const raw =
    textOf(
      block.querySelector('.match-page--title, h1, h2, h3, h4, .team-name, .math-p-stat-title'),
    ) ||
    block.getAttribute('data-team') ||
    '';
  return raw.replace(/^.*?команды\s*/i, '').trim() || raw;
}

function parseTeamBlock(block: HTMLElement): ParsedTeam {
  const name = teamTitle(block);
  const table = block.querySelector('table') ?? block;
  const nameCol = findColumn(table, NAME_HEADER_RE);
  const timeCol = findColumn(table, TIME_HEADER_RE);

  const players: ParsedPlayer[] = [];
  for (const row of table.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('th, td');
    if (cells.length === 0) continue;

    // Имя: из колонки «Игрок», иначе — первая ячейка с буквами и пробелом.
    let playerName = nameCol >= 0 && nameCol < cells.length ? textOf(cells[nameCol]) : '';
    if (!playerName) {
      playerName = cells.map(textOf).find((t) => HAS_LETTER_RE.test(t) && t.includes(' ')) ?? '';
    }
    if (!playerName || !HAS_LETTER_RE.test(playerName)) continue; // пусто / «3/11 (27%)»
    if (NON_PLAYER_RE.test(playerName) || NAME_HEADER_RE.test(playerName)) continue; // итоги/шапка

    // Минуты: из колонки времени; фолбэк — первая ячейка вида «мм : сс».
    let minutes = 0;
    if (timeCol >= 0 && timeCol < cells.length) {
      minutes = parseMinutes(textOf(cells[timeCol]));
    } else {
      const mmss = cells.map(textOf).find((t) => /^\d{1,3}\s*:\s*\d{1,2}$/.test(t));
      minutes = mmss ? parseMinutes(mmss) : 0;
    }
    players.push({ name: playerName, minutes });
  }

  return { name, players };
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

/**
 * Выбрать блок нашей команды (RED/BLACK) и вернуть сыгравших + соперника.
 * Наш блок ищем по цвету в названии («Yandex Red»/«Yandex Black»), фолбэк — по
 * слову «yandex», иначе первый блок. Соперник — название другого блока.
 */
export function selectTeamPlayers(
  game: ParsedGame,
  team: 'RED' | 'BLACK',
): { teamName: string; opponent: string | null; played: ParsedPlayer[] } | null {
  const color = team === 'RED' ? 'red' : 'black';
  const our =
    game.teams.find((t) => t.name.toLowerCase().includes(color)) ??
    game.teams.find((t) => t.name.toLowerCase().includes('yandex')) ??
    game.teams[0];
  if (!our) return null;
  const opponent = game.teams.find((t) => t !== our)?.name ?? null;
  const played = our.players.filter((p) => p.minutes > 0);
  return { teamName: our.name, opponent, played };
}
