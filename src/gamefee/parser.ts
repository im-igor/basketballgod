import { parse, type HTMLElement } from 'node-html-parser';

/**
 * Детерминированный парсер статистики матча с сайтов ЛЧБ и МЛБЛ (без LLM).
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
const USER_AGENT = 'basketballgod/1.0 (+stats parser)';
const TIMEOUT_MS = 15_000;
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
  /** Дата из источника, если источник её надёжно отдаёт. */
  date?: string | null;
}

export type GameStatsSource = 'LCHB' | 'MLBL';

export interface GameStatsRef {
  source: GameStatsSource;
  externalId: string;
  url: URL;
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

function isoFromRuDate(value: unknown): string | null {
  const m = String(value ?? '').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Проверяет ссылку статистики и извлекает ID матча для дедупликации/поиска расписания. */
export function gameStatsRef(rawUrl: string): GameStatsRef {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('Некорректная ссылка на статистику матча');
  }
  if (url.protocol !== 'https:') throw new Error('Ссылка на статистику должна использовать HTTPS');

  const host = url.hostname.toLowerCase();
  const lchb = url.pathname.match(/^\/matches\/(\d+)\/?$/);
  if (host === 'basketball.businesschampions.ru' && lchb?.[1]) {
    return { source: 'LCHB', externalId: lchb[1], url };
  }

  const mlbl = url.pathname.match(/^\/games\/(\d+)\/?$/);
  if ((host === 'ilovebasket.ru' || host.endsWith('.ilovebasket.ru')) && mlbl?.[1]) {
    return { source: 'MLBL', externalId: mlbl[1], url };
  }

  throw new Error('Поддерживаются ссылки на матчи ЛЧБ и МЛБЛ (*.ilovebasket.ru/games/ID)');
}

/** Канонический URL не зависит от #protocol, lang и способа кодирования apiUrl. */
export function canonicalGameStatsUrl(ref: GameStatsRef): string {
  const path = ref.source === 'LCHB'
    ? `/matches/${ref.externalId}/`
    : `/games/${ref.externalId}`;
  const canonical = new URL(path, ref.url.origin);
  const apiRaw = ref.source === 'MLBL' ? ref.url.searchParams.get('apiUrl') : null;
  if (apiRaw) canonical.searchParams.set('apiUrl', assertMlblApiUrl(apiRaw).origin);
  return canonical.toString();
}

function isAllowedFetchUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'basketball.businesschampions.ru' ||
    host === 'ilovebasket.ru' || host.endsWith('.ilovebasket.ru') ||
    host === 'infobasket.su' || host.endsWith('.infobasket.su');
}

function assertMlblApiUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Страница МЛБЛ указала некорректный адрес API');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(host === 'infobasket.su' || host.endsWith('.infobasket.su'))) {
    throw new Error(`Страница МЛБЛ указала неподдерживаемый API: ${url.origin}`);
  }
  return url;
}

async function fetchText(initialUrl: URL): Promise<string> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!isAllowedFetchUrl(url)) throw new Error(`Переход на неподдерживаемый адрес: ${url.origin}`);
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`${url.hostname}: редирект без адреса`);
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) throw new Error(`Не удалось загрузить статистику (${res.status}) по ${url}`);
    return res.text();
  }
  throw new Error(`${initialUrl.hostname}: слишком много редиректов`);
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

export function parseLchbGameHtml(
  html: string,
  selectors: string[] = DEFAULT_TEAM_SELECTORS,
): ParsedGame {
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

interface MlblPlayerJson {
  FirstNameRu?: unknown;
  LastNameRu?: unknown;
  PersonNameRu?: unknown;
  Seconds?: unknown;
  PlayedTime?: unknown;
}

interface MlblTeamJson {
  TeamName?: {
    CompTeamNameRu?: unknown;
    CompTeamShortNameRu?: unknown;
  } | null;
  Players?: MlblPlayerJson[] | null;
}

interface MlblOnlineJson {
  GameDate?: unknown;
  GameTeams?: MlblTeamJson[] | null;
}

/** Преобразует публичный JSON виджета МЛБЛ; поле Seconds соответствует колонке «СВ». */
export function parseMlblOnlineJson(raw: unknown): ParsedGame {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('API МЛБЛ вернул некорректный протокол');
  }
  const data = raw as MlblOnlineJson;
  if (!Array.isArray(data.GameTeams)) {
    throw new Error('В протоколе МЛБЛ не найдены команды');
  }

  const teams: ParsedTeam[] = data.GameTeams.map((team) => {
    const name = String(
      team.TeamName?.CompTeamNameRu ?? team.TeamName?.CompTeamShortNameRu ?? '',
    ).trim();
    const players: ParsedPlayer[] = (Array.isArray(team.Players) ? team.Players : [])
      .map((player) => {
        const first = String(player.FirstNameRu ?? '').trim();
        const last = String(player.LastNameRu ?? '').trim();
        const full = String(player.PersonNameRu ?? '').trim();
        const playerName = [first, last].filter(Boolean).join(' ') || full;
        const seconds = Number(player.Seconds);
        const minutes = Number.isFinite(seconds) && seconds >= 0
          ? seconds / 60
          : parseMinutes(String(player.PlayedTime ?? ''));
        return { name: playerName, minutes };
      })
      .filter((player) => player.name.length > 0);
    return { name, players };
  }).filter((team) => team.name.length > 0);

  if (teams.length === 0) throw new Error('В протоколе МЛБЛ не найдены команды');
  return { teams, date: isoFromRuDate(data.GameDate) };
}

async function fetchMlblStats(ref: GameStatsRef): Promise<ParsedGame> {
  let apiRaw = ref.url.searchParams.get('apiUrl');
  if (!apiRaw) {
    const root = parse(await fetchText(ref.url));
    apiRaw = root.querySelector('game-widget')?.getAttribute('api-url') ?? null;
  }
  if (!apiRaw) throw new Error('В ссылке/странице МЛБЛ не указан адрес API протокола');

  const endpoint = new URL(`/Widget/GetOnline/${ref.externalId}`, assertMlblApiUrl(apiRaw));
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('lang', 'ru');
  let raw: unknown;
  try {
    raw = JSON.parse(await fetchText(endpoint));
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('API МЛБЛ вернул протокол не в формате JSON');
    throw err;
  }
  return parseMlblOnlineJson(raw);
}

export async function fetchGameStats(
  rawUrl: string,
  selectors: string[] = DEFAULT_TEAM_SELECTORS,
): Promise<ParsedGame> {
  const ref = gameStatsRef(rawUrl);
  if (ref.source === 'MLBL') return fetchMlblStats(ref);
  return parseLchbGameHtml(await fetchText(ref.url), selectors);
}

/**
 * Выбрать блок нашей команды (RED/BLACK) и вернуть сыгравших + соперника.
 * Наш блок ищем по цвету в названии («Yandex Red»/«Yandex Black»), фолбэк — по
 * слову «yandex». Если команды Yandex нет, не угадываем. Соперник — другой блок.
 */
export function selectTeamPlayers(
  game: ParsedGame,
  team: 'RED' | 'BLACK',
): { teamName: string; opponent: string | null; played: ParsedPlayer[] } | null {
  const color = team === 'RED' ? 'red' : 'black';
  const our =
    game.teams.find((t) => t.name.toLowerCase().includes(color)) ??
    game.teams.find((t) => t.name.toLowerCase().includes('yandex'));
  if (!our) return null;
  const opponent = game.teams.find((t) => t !== our)?.name ?? null;
  const played = our.players.filter((p) => p.minutes > 0);
  return { teamName: our.name, opponent, played };
}
