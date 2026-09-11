import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseLchbLocationHtml,
  parseLchbScheduleHtml,
  parseMlblCompetitionsHtml,
  parseMlblGames,
} from './parser.js';

test('парсит строку расписания ЛЧБ', () => {
  const html = `<section class="team-tab-content__schedule"><table><tbody>
    <tr data-match="951788">
      <td class="table-item__position">Тур 1</td>
      <td class="table-item__position">Алмаз</td>
      <td class="table-item__position">20.09, 17:00</td>
      <td class="team-schedule-table__versus">
        <div class="games-list__team-name"><a>Московская Биржа</a></div>
        <div class="games-list__game-time"><a href="/matches/951788/">41:48</a></div>
        <div class="games-list__team-name"><a>Yandex Red</a></div>
      </td>
    </tr></tbody></table></section>`;
  assert.deepEqual(
    parseLchbScheduleHtml(
      html,
      'https://basketball.businesschampions.ru/osen-2025/komandy/142588/',
      'RED',
    ),
    [{
      source: 'LCHB',
      source_url: 'https://basketball.businesschampions.ru/osen-2025/komandy/142588/',
      external_id: '951788',
      team: 'RED',
      team_a: 'Московская Биржа',
      team_b: 'Yandex Red',
      game_date: '2025-09-20',
      game_time: '17:00',
      location: null,
      details_url: 'https://basketball.businesschampions.ru/matches/951788/',
    }],
  );
});

test('парсит площадку ЛЧБ только до переноса строки', () => {
  assert.equal(
    parseLchbLocationHtml('<div class="nogame-info__match-stadium">Территория мяча. Площадка №2.<br>Дивизион «Алмаз»</div>'),
    'Территория мяча. Площадка №2.',
  );
});

test('парсит список соревнований и только запланированные матчи Yandex Black из МЛБЛ', () => {
  assert.deepEqual(
    parseMlblCompetitionsHtml('<script>window.comps = [{"id":142708,"apiUrl":"https://reg.infobasket.su"}];</script>'),
    [{ id: 142708, apiUrl: 'https://reg.infobasket.su' }],
  );
  const games = parseMlblGames([
    {
      GameID: 1090210,
      GameDate: '20.09.2026',
      GameTime: '15:00',
      HasTime: true,
      GameStatus: 0,
      ShortTeamNameAru: 'Yandex Black',
      ShortTeamNameBru: 'Jumpball Строгино ',
      ArenaRu: 'Дружба. Зал 3',
    },
    {
      GameID: 1,
      GameDate: '20.09.2026',
      GameTime: '12:00',
      HasTime: true,
      GameStatus: 1,
      ShortTeamNameAru: 'Yandex Black',
      ShortTeamNameBru: 'Сыгранный матч',
    },
    {
      GameID: 2,
      GameDate: '20.09.2026',
      GameTime: '10:00',
      HasTime: true,
      GameStatus: 0,
      ShortTeamNameAru: 'Чужая команда',
      ShortTeamNameBru: 'Другой соперник',
    },
  ], 'https://moscow.ilovebasket.ru/schedule', 'BLACK', 'https://reg.infobasket.su');
  assert.equal(games.length, 1);
  assert.deepEqual(games[0], {
    source: 'MLBL',
    source_url: 'https://moscow.ilovebasket.ru/schedule',
    external_id: '1090210',
    team: 'BLACK',
    team_a: 'Yandex Black',
    team_b: 'Jumpball Строгино',
    game_date: '2026-09-20',
    game_time: '15:00',
    location: 'Дружба. Зал 3',
    details_url: 'https://moscow.ilovebasket.ru/games/1090210?apiUrl=https%3A%2F%2Freg.infobasket.su',
  });
});
