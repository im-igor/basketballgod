import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalGameStatsUrl,
  gameStatsRef,
  parseMlblOnlineJson,
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
