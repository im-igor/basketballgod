import { parse } from 'node-html-parser';
import type { ScheduleSource, Team } from '../db/types.js';
import type { ScheduledGameInput } from '../db/repos/scheduledGames.repo.js';

const USER_AGENT = 'basketballgod/1.0 schedule importer';
const TIMEOUT_MS = 20_000;
const MLBL_TEAM: Record<Team, string> = { RED: 'Yandex Red', BLACK: 'Yandex Black' };

interface MlblCompetition {
  id: number;
  apiUrl: string;
}

interface MlblGame {
  GameID?: number;
  GameDate?: string;
  GameTime?: string;
  HasTime?: boolean;
  GameStatus?: number;
  ShortTeamNameAru?: string;
  ShortTeamNameBru?: string;
  ArenaRu?: string;
}

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalized(value: string): string {
  return clean(value).toLocaleLowerCase('ru-RU');
}

function expectedTeamName(team: Team): string {
  return normalized(MLBL_TEAM[team]);
}

function isOurMatch(team: Team, teamA: string, teamB: string): boolean {
  const expected = expectedTeamName(team);
  return normalized(teamA).includes(expected) || normalized(teamB).includes(expected);
}

function isoDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function assertSourceUrl(rawUrl: string): { url: URL; source: ScheduleSource } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Некорректный URL страницы расписания');
  }
  if (url.protocol !== 'https:') throw new Error('Страница расписания должна использовать HTTPS');
  const host = url.hostname.toLowerCase();
  if (host === 'basketball.businesschampions.ru') return { url, source: 'LCHB' };
  if (host === 'ilovebasket.ru' || host.endsWith('.ilovebasket.ru')) return { url, source: 'MLBL' };
  throw new Error('Поддерживаются только страницы basketball.businesschampions.ru и *.ilovebasket.ru');
}

/** Проверить URL без сетевого запроса и определить турнир по разрешённому домену. */
export function scheduleSourceForUrl(rawUrl: string): ScheduleSource {
  return assertSourceUrl(rawUrl.trim()).source;
}

function assertMlblApiUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(host === 'infobasket.su' || host.endsWith('.infobasket.su'))) {
    throw new Error(`Страница МЛБЛ указала неподдерживаемый API: ${url.origin}`);
  }
  return url;
}

function isAllowedFetchUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'basketball.businesschampions.ru' ||
    host === 'ilovebasket.ru' || host.endsWith('.ilovebasket.ru') ||
    host === 'infobasket.su' || host.endsWith('.infobasket.su');
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
    if (!res.ok) throw new Error(`${url.hostname}: HTTP ${res.status}`);
    return res.text();
  }
  throw new Error(`${initialUrl.hostname}: слишком много редиректов`);
}

/** Чистый HTML-парсер ЛЧБ. Место проведения добавляется из страницы матча отдельно. */
export function parseLchbScheduleHtml(
  html: string,
  pageUrl: string,
  team: Team,
): ScheduledGameInput[] {
  const url = new URL(pageUrl);
  const yearMatch = url.pathname.match(/(?:^|\/)[^/]*?(20\d{2})(?:\/|$)/);
  const year = Number(yearMatch?.[1]);
  if (!Number.isInteger(year)) throw new Error('Не удалось определить год сезона из URL ЛЧБ');

  const root = parse(html);
  const rows = root.querySelectorAll('.team-tab-content__schedule tbody tr[data-match]');
  const games: ScheduledGameInput[] = [];
  for (const row of rows) {
    const externalId = clean(row.getAttribute('data-match'));
    const dateCells = row.querySelectorAll('td.table-item__position');
    const dateText = clean(dateCells[2]?.textContent);
    const dm = dateText.match(/^(\d{1,2})\.(\d{1,2})\s*,\s*(\d{1,2}):(\d{2})/);
    const names = row
      .querySelectorAll('.team-schedule-table__versus .games-list__team-name a')
      .map((node) => clean(node.textContent))
      .filter(Boolean);
    if (!externalId || !dm || names.length < 2) continue;
    const teamA = names[0]!;
    const teamB = names[1]!;
    if (!isOurMatch(team, teamA, teamB)) continue;
    const gameDate = isoDate(year, Number(dm[2]), Number(dm[1]));
    if (!gameDate) continue;
    const detailsHref = row.querySelector('.games-list__game-time a')?.getAttribute('href');
    games.push({
      source: 'LCHB',
      source_url: url.toString(),
      external_id: externalId,
      team,
      team_a: teamA,
      team_b: teamB,
      game_date: gameDate,
      game_time: `${dm[3]!.padStart(2, '0')}:${dm[4]}`,
      location: null,
      details_url: detailsHref ? new URL(detailsHref, url).toString() : null,
    });
  }
  return games;
}

/** Первая строка блока на странице матча ЛЧБ — название площадки. */
export function parseLchbLocationHtml(html: string): string | null {
  const root = parse(html);
  const stadium = root.querySelector('.nogame-info__match-stadium');
  if (!stadium) return null;
  const firstLine = stadium.innerHTML.split(/<br\s*\/?>/i)[0] ?? '';
  const location = clean(parse(firstLine).textContent);
  return location || null;
}

export function parseMlblCompetitionsHtml(html: string): MlblCompetition[] {
  const match = html.match(/window\.comps\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!match?.[1]) throw new Error('Страница МЛБЛ не содержит список соревнований');
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    throw new Error('Не удалось разобрать список соревнований МЛБЛ');
  }
  if (!Array.isArray(value)) throw new Error('Некорректный список соревнований МЛБЛ');
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map((v) => ({ id: Number(v.id), apiUrl: String(v.apiUrl ?? '') }))
    .filter((v) => Number.isInteger(v.id) && v.apiUrl.length > 0);
}

/** Чистое преобразование ответа API МЛБЛ; импортируются только запланированные матчи нашей команды. */
export function parseMlblGames(
  rawGames: unknown,
  pageUrl: string,
  team: Team,
  apiUrl: string,
): ScheduledGameInput[] {
  if (!Array.isArray(rawGames)) return [];
  const page = new URL(pageUrl);
  const games: ScheduledGameInput[] = [];
  for (const raw of rawGames as MlblGame[]) {
    const externalId = raw.GameID == null ? '' : String(raw.GameID);
    const teamA = clean(raw.ShortTeamNameAru);
    const teamB = clean(raw.ShortTeamNameBru);
    const dm = clean(raw.GameDate).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    // GameStatus=0 — матч запланирован. Завершённые результаты в календарь не импортируем.
    if (!externalId || !teamA || !teamB || !dm || raw.GameStatus !== 0) continue;
    if (!isOurMatch(team, teamA, teamB)) continue;
    const gameDate = isoDate(Number(dm[3]), Number(dm[2]), Number(dm[1]));
    if (!gameDate) continue;
    const time = clean(raw.GameTime);
    games.push({
      source: 'MLBL',
      source_url: page.toString(),
      external_id: externalId,
      team,
      team_a: teamA,
      team_b: teamB,
      game_date: gameDate,
      game_time: raw.HasTime !== false && /^\d{2}:\d{2}$/.test(time) ? time : null,
      location: clean(raw.ArenaRu) || null,
      details_url: new URL(`/games/${externalId}?apiUrl=${encodeURIComponent(apiUrl)}`, page).toString(),
    });
  }
  return games;
}

async function fetchLchb(url: URL, team: Team): Promise<ScheduledGameInput[]> {
  const games = parseLchbScheduleHtml(await fetchText(url), url.toString(), team);
  await Promise.all(
    games.map(async (game) => {
      if (!game.details_url) return;
      game.location = parseLchbLocationHtml(await fetchText(new URL(game.details_url)));
    }),
  );
  return games;
}

async function fetchMlbl(url: URL, team: Team): Promise<ScheduledGameInput[]> {
  const comps = parseMlblCompetitionsHtml(await fetchText(url));
  if (comps.length === 0) throw new Error('На странице МЛБЛ не найдено соревнований');
  const responses = await Promise.allSettled(
    comps.map(async (comp) => {
      const api = assertMlblApiUrl(comp.apiUrl);
      const endpoint = new URL('/Comp/GetCalendarCarousel/', api);
      endpoint.searchParams.set('comps', String(comp.id));
      endpoint.searchParams.set('format', 'json');
      endpoint.searchParams.set('from', 'today-365');
      endpoint.searchParams.set('max', '500');
      const raw: unknown = JSON.parse(await fetchText(endpoint));
      return parseMlblGames(raw, url.toString(), team, api.origin);
    }),
  );
  const successful = responses.filter(
    (r): r is PromiseFulfilledResult<ScheduledGameInput[]> => r.status === 'fulfilled',
  );
  if (successful.length === 0) throw new Error('Все запросы к API МЛБЛ завершились ошибкой');
  const unique = new Map<string, ScheduledGameInput>();
  for (const result of successful) {
    for (const game of result.value) unique.set(game.external_id, game);
  }
  return [...unique.values()].sort((a, b) =>
    `${a.game_date} ${a.game_time ?? ''}`.localeCompare(`${b.game_date} ${b.game_time ?? ''}`),
  );
}

export async function fetchSchedulePage(rawUrl: string, team: Team): Promise<ScheduledGameInput[]> {
  const { url, source } = assertSourceUrl(rawUrl.trim());
  const games = source === 'LCHB' ? await fetchLchb(url, team) : await fetchMlbl(url, team);
  if (games.length === 0) {
    throw new Error(`Не найдено матчей ${MLBL_TEAM[team]} на этой странице`);
  }
  return games;
}
