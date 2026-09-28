import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createGameServer } from '../server.js';
import { makeDeck, classify } from '../lib/game.js';
import { createRoom, joinRoom } from './lobby-helper.mjs';
const game = createGameServer({ dealDelayMs: 0, actionDelayMs: 0, turnMs: 600000 });
await new Promise(resolve => game.httpServer.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${game.httpServer.address().port}`;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const errors = [];
await fs.mkdir('test-results', { recursive: true });
try {
  const pages = [];
  for (let i = 0; i < 4; i++) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); pages.push(page);
  }
  const a = pages[0]; await a.goto(url);
  for (const width of [320, 375, 768, 1366]) {
    await a.setViewportSize({ width, height: 768 });
    assert.equal(await a.locator('.entry-actions button').count(), 2);
  }
  await a.locator('#nickname').fill('阿青'); await createRoom(a, { players: 4 });
  await a.locator('#game').waitFor({ state: 'visible' });
  const code = await a.locator('#room-title').textContent();
  for (let i = 1; i < 4; i++) {
    await pages[i].goto(`${url}/?room=${code}`); await pages[i].locator('#nickname').fill(['', '小满', '老周', '芽芽'][i]);
    await joinRoom(pages[i], code);
  }
  assert.equal(await a.locator('#top-player .player-name').textContent(), '老周');
  for (const page of pages) await page.locator('[data-action="ready"]').click();
  const room = game.rooms.get(code);
  const bidder = pages[room.turn]; await bidder.locator('[data-action="bid-3"]').click();
  await bidder.waitForFunction(() => document.querySelectorAll('#hand .playing-card').length === 33);
  // Keep one landlord at 33 cards while filling all three fixed play zones.
  const deck = makeDeck('four');
  for (const p of room.players.filter(p => p.id !== room.landlordId)) {
    const played = deck.filter(c => c.rank >= 3 && c.rank <= 14 && c.suit === '♠' && c.id < 54);
    room.tablePlays[p.id] = { playerId: p.id, cards: played, combo: classify(played, 'four'), sequence: ++room.playSequence };
  }
  await bidder.reload(); await bidder.locator('#top-play .playing-card').first().waitFor();
  for (const viewport of [ { width: 320, height: 667 }, { width: 375, height: 667 }, { width: 414, height: 896 }, { width: 768, height: 900 }, { width: 1280, height: 800 }, { width: 1366, height: 768 } ]) {
    await bidder.setViewportSize(viewport); await bidder.waitForTimeout(200);
    const bounds = await bidder.evaluate(() => {
      const clipped = [...document.querySelectorAll('.player-play .playing-card')].filter(card => {
        const box = card.getBoundingClientRect(), zone = card.closest('.player-play').getBoundingClientRect();
        const scroller = card.closest('.table-cards'), scrollBox = scroller.getBoundingClientRect();
        return box.top < zone.top || box.bottom + 2 > zone.bottom || box.bottom + 2 > scrollBox.top + scroller.clientHeight;
      });
      return { height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth, clipped: clipped.length,
        hand: [...document.querySelectorAll('#hand .playing-card')].every(card => { const b = card.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight; }) };
    });
    await bidder.screenshot({ path: `test-results/four-${viewport.width}.png`, fullPage: true });
    assert.equal(bounds.clipped, 0, `played cards at ${JSON.stringify(viewport)}: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.height <= viewport.height && bounds.width <= viewport.width && bounds.hand, `viewport ${JSON.stringify(viewport)}: ${JSON.stringify(bounds)}`);
  }
  const before = await bidder.locator('.arena').boundingBox(); room.tablePlays = {};
  await bidder.reload(); await bidder.locator('#hand .playing-card').first().waitFor();
  const after = await bidder.locator('.arena').boundingBox(); assert.equal(after.height, before.height);
  await bidder.locator('#hand .playing-card').first().click({ position: { x: 6, y: 15 } }); assert.equal(await bidder.locator('#hand .selected').count(), 1);
  const botContext = await browser.newContext({ viewport: { width: 320, height: 667 }, reducedMotion: 'reduce' });
  const solo = await botContext.newPage(); solo.on('pageerror', e => errors.push(e.message));
  await solo.goto(url);
  await solo.locator('#nickname').fill('单人试玩'); await createRoom(solo, { players: 4 });
  await solo.locator('[data-action="fill-bots"]').click(); await solo.locator('#top-player .role-bot').waitFor();
  assert.equal(await solo.locator('.player-slot .role-bot').count(), 3);
  await solo.locator('[data-action="ready"]').click(); await solo.locator('#hand .playing-card').first().waitFor();
  const botRoom = game.rooms.get(await solo.locator('#room-title').textContent()); clearTimeout(botRoom.timer);
  botRoom.phase = 'playing'; botRoom.landlordId = botRoom.players[0].id; botRoom.turn = 0;
  botRoom.players[0].hand.push(...botRoom.bottom);
  await solo.reload(); await solo.locator('#top-player .role-farmer').waitFor();
  const overlapping = await solo.locator('.player-slot').evaluateAll(seats => seats.filter(seat => {
    const box = seat.getBoundingClientRect();
    const role = seat.querySelector('.player-role').getBoundingClientRect();
    const status = seat.querySelector('.seat-status').getBoundingClientRect();
    const play = document.querySelector(`#${seat.id.replace('player', 'play')}`).getBoundingClientRect();
    return role.left < box.left - 1 || role.right > box.right + 1 || status.bottom > play.top;
  }).map(seat => ({ id: seat.id, seat: seat.getBoundingClientRect().toJSON(), role: seat.querySelector('.player-role').getBoundingClientRect().toJSON(), status: seat.querySelector('.seat-status').getBoundingClientRect().toJSON(), play: document.querySelector(`#${seat.id.replace('player', 'play')}`).getBoundingClientRect().toJSON() })));
  await solo.screenshot({ path: 'test-results/four-bots-320.png', fullPage: true });
  assert.deepEqual(overlapping, [], 'bot roles, card counts and plays stay within their own seats');
  assert.equal(await solo.evaluate(() => document.documentElement.scrollHeight > innerHeight), false);
  botRoom.players[0].hand = [...deck.filter(c => c.rank >= 16), deck[0]];
  botRoom.tablePlays = {}; botRoom.lastPlay = null;
  await solo.emulateMedia({ reducedMotion: 'no-preference' }); await solo.reload(); await solo.bringToFront();
  await solo.locator('#hand [data-rank="17"]').first().waitFor();
  for (const card of await solo.locator('#hand [data-rank="16"], #hand [data-rank="17"]').all()) await card.click({ position: { x: 6, y: 15 } });
  await solo.locator('[data-action="play"]').click(); await solo.locator('.fx-launch-four').waitFor();
  assert.equal(await solo.locator('.fx-launch-four .fx-launcher').count(), 4);
  assert.ok((await solo.locator('#table-event').textContent()).includes('四王炸'));
  clearTimeout(botRoom.timer); botRoom.phase = 'finished';
  botRoom.result = { landlordWon: false, spring: false, multiplier: 2, winnerId: botRoom.players[1].id, deltas: botRoom.players.map((p, i) => ({ id: p.id, delta: i ? 2 : -6 })) };
  botRoom.players[1].hand = []; botRoom.players.forEach(p => { p.ready = Boolean(p.bot); });
  await solo.reload(); await solo.locator('.revealed-hand').first().waitFor();
  assert.equal(await solo.locator('.revealed-hand').count(), 3);
  assert.ok((await solo.locator('#turn-message').textContent()).includes('3/4'));
  const clippedRemaining = await solo.locator('.revealed-hand .table-cards').evaluateAll(scrollers => scrollers.filter(scroller => {
    scroller.scrollLeft = scroller.scrollWidth;
    const last = scroller.querySelector('.playing-card:last-child'); if (!last) return false;
    const card = last.getBoundingClientRect(), box = scroller.getBoundingClientRect();
    return card.bottom + 2 > box.top + scroller.clientHeight || card.right > box.right + 1;
  }).length);
  assert.equal(clippedRemaining, 0); assert.equal(await solo.evaluate(() => document.documentElement.scrollHeight > innerHeight), false);
  assert.deepEqual(errors, []);
  console.log('Four-player UI: four browsers, seat mapping, 33-card hand, six viewports, uncropped plays and stable table passed.');
} finally { await browser.close(); await game.close(); }
