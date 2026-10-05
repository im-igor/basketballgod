import type { ScheduledGame, ScheduleSource, Team } from '../db/types.js';

export type ScheduledFixture = Pick<
  ScheduledGame,
  'source' | 'team' | 'team_a' | 'team_b' | 'game_date' | 'game_time'
>;

function dateKey(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** Названия команд сравниваем без регистра, лишних пробелов и различия е/ё. */
export function normalizeScheduledTeamName(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Порядок «хозяева/гости» не должен мешать распознать тот же матч. */
export function scheduledMatchupKey(teamA: string, teamB: string): string {
  return [normalizeScheduledTeamName(teamA), normalizeScheduledTeamName(teamB)]
    .sort((a, b) => a.localeCompare(b, 'ru'))
    .join('\u0000');
}

export function scheduledFixtureKey(game: ScheduledFixture): string {
  const time = game.game_time ? String(game.game_time).slice(0, 5) : '';
  return [
    game.source,
    game.team,
    dateKey(game.game_date),
    time,
    scheduledMatchupKey(game.team_a, game.team_b),
  ].join('\u0001');
}

export interface ScheduleDuplicateGroup {
  source: ScheduleSource;
  team: Team;
  fixtureKey: string;
  games: ScheduledGame[];
}

export function groupScheduleDuplicates(games: ScheduledGame[]): ScheduleDuplicateGroup[] {
  const groups = new Map<string, ScheduledGame[]>();
  for (const game of games) {
    const key = scheduledFixtureKey(game);
    const group = groups.get(key) ?? [];
    group.push(game);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([fixtureKey, group]) => ({
      source: group[0]!.source,
      team: group[0]!.team,
      fixtureKey,
      games: group.sort((a, b) => Number(a.id) - Number(b.id)),
    }));
}
