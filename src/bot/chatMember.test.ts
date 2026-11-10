import '../test/env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bot, Context } from 'grammy';
import type { Player } from '../db/types.js';

test('уведомляет администраторов, когда игрок выходит из домашнего чата', async () => {
  const { createChatMemberHandler, registerChatMemberNotifications } = await import('./chatMember.js');
  const player: Player = {
    id: 1, name: 'Тестовый Игрок', tg_login: '@player', tg_user_id: 123,
    team: 'RED', is_employee: false, active: true, active_from: null, active_to: null, notes: null,
  };
  const handler = createChatMemberHandler(async (id) => id === 123 ? player : null, [524515690]);

  const sent: Array<[number, string]> = [];
  const exitedRedChat = {
    chatMember: {
      chat: { id: -2 },
      old_chat_member: { status: 'member', user: { id: 123 } },
      new_chat_member: { status: 'left', user: { id: 123 } },
    },
    api: { sendMessage: async (chatId: number, text: string) => { sent.push([chatId, text]); } },
  } as unknown as Context;
  await handler(exitedRedChat);
  assert.deepEqual(sent, [[524515690, '🏀 Игрок Тестовый Игрок (@player) вышел из чата RED.']]);

  await handler({
    ...exitedRedChat,
    chatMember: {
      ...exitedRedChat.chatMember,
      old_chat_member: { status: 'left', user: { id: 123 } },
      new_chat_member: { status: 'member', user: { id: 123 } },
    },
  } as unknown as Context);
  assert.equal(sent.length, 1, 'вход и смена роли не должны присылать уведомление');

  await handler({
    ...exitedRedChat,
    chatMember: { ...exitedRedChat.chatMember, chat: { id: -1 } },
  } as unknown as Context);
  assert.equal(sent.length, 1, 'выход не из домашнего чата игрока игнорируется');

  const handlers = new Map<string, (ctx: Context) => Promise<void>>();
  const bot = { on: (name: string, registered: (ctx: Context) => Promise<void>) => { handlers.set(name, registered); } } as unknown as Bot;
  registerChatMemberNotifications(bot);
  assert.ok(handlers.has('chat_member'), 'обработчик подключён к экземпляру бота');
});
