import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalGameStatsUrl,
  gameStatsRef,
  parseMlblOnlineJson,
  parseLchbGameHtml,
  selectTeamPlayers,
} from './parser.js';

test('извлекает источник и ID из ссылки на протокол МЛБЛ', () => {
  const ref = gameStatsRef(
    'https://moscow.ilovebasket.ru/games/779229?apiUrl=https://reg.infobasket.su&lang=ru#protocol',
  );
  assert.equal(ref.source, 'MLBL');
  assert.equal(ref.externalId, '779229');
  assert.equal(
    canonicalGameStatsUrl(ref),
    'https://moscow.ilovebasket.ru/games/779229?apiUrl=https%3A%2F%2Freg.infobasket.su',
  );
});

test('принимает сезонную ссылку на протокол ЛЧБ', () => {
  const ref = gameStatsRef(
    'https://basketball.businesschampions.ru/vesna-2026/matches/1469962/',
  );
  assert.equal(ref.source, 'LCHB');
  assert.equal(ref.externalId, '1469962');
  assert.equal(
    canonicalGameStatsUrl(ref),
    'https://basketball.businesschampions.ru/vesna-2026/matches/1469962/',
  );
});

test('парсит СВ из JSON МЛБЛ и оставляет только реально сыгравших', () => {
  const game = parseMlblOnlineJson({
    GameDate: '20.09.2026',
    GameTeams: [
      {
        TeamName: { CompTeamNameRu: 'Yandex Black' },
        Players: [
          { FirstNameRu: 'Иван', LastNameRu: 'Игроков', Seconds: 61, PlayedTime: '1:01' },
          { FirstNameRu: 'Пётр', LastNameRu: 'Запасной', Seconds: 0, PlayedTime: '0:00' },
        ],
      },
      {
        TeamName: { CompTeamNameRu: 'Соперник' },
        Players: [{ FirstNameRu: 'Другой', LastNameRu: 'Игрок', Seconds: 2400 }],
      },
    ],
  });

  assert.equal(game.date, '2026-09-20');
  assert.deepEqual(selectTeamPlayers(game, 'BLACK'), {
    teamName: 'Yandex Black',
    opponent: 'Соперник',
    played: [{ name: 'Иван Игроков', minutes: 61 / 60 }],
  });
});

test('не принимает чужую игру за матч Yandex Black', () => {
  const game = parseMlblOnlineJson({
    GameDate: '24.09.2023',
    GameTeams: [
      { TeamName: { CompTeamNameRu: 'Team Team United' }, Players: [] },
      { TeamName: { CompTeamNameRu: 'Лотос (2)' }, Players: [] },
    ],
  });
  assert.equal(selectTeamPlayers(game, 'BLACK'), null);
});

test('не выбирает соперника по цвету и не подменяет Black командой Red', () => {
  const t = (name: string) => ({ name, players: [{ name: 'Игрок Один', minutes: 40 }] });
  assert.equal(selectTeamPlayers({ teams: [t('Red Opponent'), t('Yandex Black')] }, 'BLACK')?.teamName, 'Yandex Black');
  assert.equal(selectTeamPlayers({ teams: [t('Yandex Red'), t('Opponent')] }, 'BLACK'), null);
  assert.equal(selectTeamPlayers({ teams: [t('Yandex Black'), t('Yandex Black')] }, 'BLACK'), null);
});

test('не превращает отрицательное время МЛБЛ в нулевое или положительное', () => {
  const game = parseMlblOnlineJson({ GameTeams: [{ TeamName: { CompTeamNameRu: 'Yandex Black' },
    Players: [{ FirstNameRu: 'Иван', LastNameRu: 'Игроков', Seconds: -1 }] }] });
  assert.ok(Number.isNaN(game.teams[0]!.players[0]!.minutes));
});


test('строка шапки ЛЧБ с colspan не становится игроком', () => {
  const game = parseLchbGameHtml(`<div class="math-p-stat"><h2>Статистика команды Yandex Red</h2>
    <table><thead><tr><th colspan="2"></th><th>Игрок</th><th>Очки</th><th>ВР</th></tr></thead>
    <tbody><tr><td></td><td>1</td><td>Тестовый Участник</td><td>5</td><td>12 : 30</td></tr></tbody></table></div>`);
  assert.deepEqual(game.teams[0]!.players,[{ name:'Тестовый Участник',minutes:12.5 }]);
});
