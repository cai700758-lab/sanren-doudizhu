import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createGameServer } from '../server.js';
import { makeDeck, classify, modeRules } from '../lib/game.js';
import { createRoom } from './lobby-helper.mjs';
const game = createGameServer({ dealDelayMs: 0, actionDelayMs: 0, botDelayMs: 600000, turnMs: 600000 });
await new Promise(resolve => game.httpServer.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${game.httpServer.address().port}`;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const errors = [];
await fs.mkdir('test-results', { recursive: true });
const viewports = [ [568, 320], [667, 375], [740, 280], [740, 360], [812, 320], [844, 390], [896, 414], [932, 430] ];
try {
  for (const mode of ['classic', 'skills', 'four', 'fourSkills']) {
    const context = await browser.newContext({ viewport: { width: 667, height: 375 }, hasTouch: true, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.setViewportSize({ width: 568, height: 320 });
    await page.screenshot({ path: `test-results/landscape-lobby-${mode}.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight), false, 'landscape lobby fits');
    await page.locator('#nickname').fill('横屏试玩'); await createRoom(page, { players: modeRules(mode).players, skills: ['skills', 'fourSkills'].includes(mode) });
    await page.locator('[data-action="fill-bots"]').click(); await page.locator('[data-action="ready"]').click();
    await page.locator('#hand .playing-card').first().waitFor();
    const room = game.rooms.get(await page.locator('#room-title').textContent()); clearTimeout(room.timer);
    room.phase = 'playing'; room.turn = 0; room.landlordId = room.players[0].id;
    room.players[0].hand = makeDeck(mode).slice(0, modeRules(mode).maxHand);
    if (['skills', 'fourSkills'].includes(mode)) room.players[0].skill = { id: 'peek', used: false, choices: null };
    const played = makeDeck(mode).filter(c => c.id < 54 && c.suit === '♠' && c.rank <= 14);
    for (const p of room.players) room.tablePlays[p.id] = { playerId: p.id, cards: played, combo: classify(played, mode), sequence: ++room.playSequence };
    await page.reload(); await page.locator('#my-play .playing-card').first().waitFor();
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height }); await page.waitForTimeout(180);
      const geometry = await page.evaluate(() => {
        const rect = node => node.getBoundingClientRect();
        const controls = [...document.querySelectorAll('#actions button')].map(rect);
        const hand = [...document.querySelectorAll('#hand .playing-card')].map(rect);
        const cards = [...document.querySelectorAll('.player-play .playing-card')];
        const clipped = cards.filter(card => {
          const b = rect(card), zone = rect(card.closest('.player-play')), scroll = card.closest('.table-cards'), s = rect(scroll);
          const index = rect(card.querySelector('.card-index'));
          return b.bottom + 1 > zone.bottom || b.bottom + 1 > s.top + scroll.clientHeight || index.bottom > b.bottom || index.top < b.top;
        });
        const footer = rect(document.querySelector('.my-footer'));
        const dock = document.querySelector('#skill-dock');
        return { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
          clipped: clipped.length, rows: document.querySelectorAll('.hand-row').length,
          controls: controls.every(b => b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth && b.height >= 38),
          hand: hand.every(b => b.top >= Math.max(...controls.map(c => c.bottom)) && b.bottom <= footer.top + 1 && b.left >= 0 && b.right <= innerWidth),
          skill: dock.hidden || (rect(dock).top > innerHeight / 2 && hand.every(b => b.left >= rect(dock).right)),
          seats: [...document.querySelectorAll('.player-slot')].filter(s => s.checkVisibility()).every(seat => rect(seat.querySelector('.opponent-hand')).top >= rect(seat.querySelector('.player-info')).bottom),
          buttons: [...document.querySelectorAll('button:enabled')].filter(b => b.checkVisibility() && b.scrollWidth > b.clientWidth + 2).map(b => b.textContent),
        };
      });
      await page.screenshot({ path: `test-results/landscape-${mode}-${width}-${height}.png`, fullPage: true });
      assert.ok(geometry.width <= width && geometry.height <= height && geometry.controls && geometry.hand && geometry.skill && geometry.seats, `${mode} ${width}x${height}: ${JSON.stringify(geometry)}`);
      assert.equal(geometry.rows, mode === 'fourSkills' ? 2 : 1); assert.equal(geometry.clipped, 0, `${mode} ${width}x${height}: clipped play cards`);
      assert.deepEqual(geometry.buttons, [], `${mode} ${width}x${height}: button text clipped`);
    }
    // A rotation must retain selected cards and keep the same room.
    await page.locator('#hand .playing-card').first().click({ position: { x: 6, y: 15 } });
    const selected = await page.locator('#hand .selected').getAttribute('data-card');
    await page.setViewportSize({ width: 375, height: 667 }); await page.waitForTimeout(180);
    assert.equal(await page.locator('#hand .selected').getAttribute('data-card'), selected);
    await page.setViewportSize({ width: 667, height: 375 }); await page.waitForTimeout(180);
    assert.equal(await page.locator('#hand .selected').getAttribute('data-card'), selected);
    await page.locator('[data-action="clear"]').click();
    const points = await page.locator('#hand .playing-card').evaluateAll(cards => cards.slice(0, 5).map(card => { const b = card.getBoundingClientRect(); return { x: b.left + 5, y: b.top + 22 }; }));
    const touch = await context.newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] });
    for (const point of points.slice(1)) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await page.locator('#hand .selected').count(), 5, 'landscape touch swipe selects all crossed cards');
    await touch.detach(); await page.locator('[data-action="clear"]').click();
    const geometryBefore = await page.locator('.arena').boundingBox();
    room.tablePlays = {}; room.tablePasses = Object.fromEntries(room.players.slice(1).map((p, i) => [p.id, { sequence: ++room.playSequence }]));
    await page.reload(); await page.locator('.pass-label').first().waitFor();
    assert.equal((await page.locator('.arena').boundingBox()).height, geometryBefore.height);
    for (const selector of ['#rules-button', '#feedback-button', '#invite-button', '#chat-button', '#history-button', ...(['skills', 'fourSkills'].includes(mode) ? ['#skill-button'] : [])]) {
      await page.locator(selector).click(); const dialog = page.locator('dialog[open]'); await dialog.waitFor();
      const box = await dialog.boundingBox(); assert.ok(box.y >= 0 && box.y + box.height <= 375);
      await dialog.locator('[data-close]').first().click();
    }
    if (['skills', 'fourSkills'].includes(mode)) {
      await page.locator('#skill-button').click(); await page.locator('[data-skill-use]').click();
      await page.locator('.skill-inspection').waitFor(); await page.locator('#skill-dialog [data-close]').click();
      await page.locator('.skill-announcement').waitFor();
      const notice = await page.locator('.skill-announcement').boundingBox();
      const actions = await page.locator('#actions').boundingBox();
      assert.ok(notice.y >= 30 && notice.y + notice.height <= actions.y + 1, 'skill notice fits above controls');
    }
    clearTimeout(room.timer); room.phase = 'finished'; room.players[0].hand = [];
    room.players.forEach(p => { p.ready = Boolean(p.bot); });
    room.result = { landlordWon: true, spring: false, multiplier: 1, winnerId: room.players[0].id,
      deltas: room.players.map((p, i) => ({ id: p.id, delta: i ? -1 : room.players.length - 1 })) };
    await page.reload(); await page.locator('[data-action="ready"]').waitFor();
    assert.equal(await page.locator('.revealed-hand').count(), room.players.length - 1);
    assert.ok((await page.locator('#turn-message').textContent()).includes(`${room.players.length - 1}/${room.players.length}`));
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), false);
    await page.screenshot({ path: `test-results/landscape-${mode}-finished.png`, fullPage: true });
    console.log(`${mode}: landscape layouts, complete plays, controls, rotation, fixed geometry and dialogs passed.`);
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await game.close(); }
