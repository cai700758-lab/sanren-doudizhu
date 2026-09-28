import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createGameServer } from '../server.js';
import { makeDeck, classify, rankLabel } from '../lib/game.js';
import { comboEffect } from '../public/combo-effects.js';
import { createRoom, joinRoom } from './lobby-helper.mjs';

const game = createGameServer({ dealDelayMs: 0, actionDelayMs: 0 });
await new Promise(resolve => game.httpServer.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${game.httpServer.address().port}`;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
await fs.mkdir('test-results', { recursive: true });
const errors = [];
try {
  const pages = [];
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await context.addInitScript(() => localStorage.setItem('sanren-sound', 'off'));
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.locator('#nickname').fill(['阿青', '小满', '老周'][i]);
    if (!i) await createRoom(page);
    else {
      await joinRoom(page, await pages[0].locator('#room-title').textContent());
    }
    await page.locator('#game').waitFor({ state: 'visible' });
  }
  for (const page of pages) await page.locator('[data-action="ready"]').click();
  const room = game.rooms.get(await pages[0].locator('#room-title').textContent());
  const leaderIndex = room.turn, leader = pages[leaderIndex];
  await leader.locator('[data-action="bid-3"]:not([disabled])').click();
  await leader.locator('[data-action="hint"]').waitFor();
  const fixtures = [
    ['straight', [3, 4, 5, 6, 7]], ['pairStraight', [3, 3, 4, 4, 5, 5]],
    ['airplane', [3, 3, 3, 4, 4, 4]], ['airplaneSingle', [3, 3, 3, 4, 4, 4, 7, 8]],
    ['airplanePair', [3, 3, 3, 4, 4, 4, 7, 7, 8, 8]],
    ['tripleSingle', [3, 3, 3, 7]], ['triplePair', [3, 3, 3, 7, 7]],
    ['fourSingle', [3, 3, 3, 3, 7, 8]], ['fourPair', [3, 3, 3, 3, 7, 7, 8, 8]],
    ['bomb', [3, 3, 3, 3]], ['rocket', [16, 17]],
  ];
  for (const [index, [type, ranks]] of fixtures.entries()) {
    const deck = makeDeck();
    const cards = ranks.map(rank => deck.splice(deck.findIndex(card => card.rank === rank), 1)[0]);
    assert.equal(classify(cards).type, type);
    // Seed a known legal hand, then submit it through the same UI and server validation as a real game.
    room.players[leaderIndex].hand = [...cards, ...deck.slice(-3)];
    room.turn = leaderIndex; room.lastPlay = null; room.tablePlays = {}; room.tablePasses = {}; room.actionAt = 0;
    const viewport = index % 2 ? { width: 375, height: 667 } : { width: 1366, height: 768 };
    await leader.setViewportSize(viewport); await leader.reload();
    await leader.locator('[data-action="hint"]:not([disabled])').waitFor();
    const geometry = () => leader.evaluate(() => ['.arena', '#actions', '#hand'].map(selector => {
      const box = document.querySelector(selector).getBoundingClientRect(); return [box.top, box.height];
    }));
    const before = await geometry();
    for (const card of cards) { await leader.locator(`#hand [data-card="${card.id}"]`).focus(); await leader.keyboard.press('Space'); }
    await leader.locator('[data-action="play"]:not([disabled])').click();
    for (const page of pages) await page.locator(`#table-event[data-event="${type}"]:visible`).waitFor();
    assert.equal(await leader.locator('#table-event').getAttribute('data-effect'), comboEffect(type).family);
    if (['straight', 'pairs', 'triple', 'four'].includes(comboEffect(type).family)) {
      assert.deepEqual(await leader.locator('.fx-mini-card b').allTextContents(), cards.slice(0, 6).map(card => rankLabel(card.rank)), 'animated card ranks match the actual play');
    }
    assert.ok(await leader.locator('.combo-art').evaluate(node => node.getAnimations({ subtree: true }).length > 0), `${type} has actual animated artwork`);
    assert.deepEqual(await geometry(), before, `${type} does not move the table`);
    assert.ok(await leader.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth), `${type} fits the viewport`);
    assert.equal(await leader.locator('.combo-art').evaluate(node => getComputedStyle(node).pointerEvents), 'none');
    await leader.waitForTimeout(350);
    await leader.screenshot({ path: `test-results/combo-${type}.png`, fullPage: true });
    if (type === 'bomb') {
      await leader.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await leader.locator('.combo-art').isVisible(), false);
      assert.equal(await leader.locator('.event-card').isVisible(), true);
      await leader.emulateMedia({ reducedMotion: 'no-preference' });
    }
    await leader.reload();
    await leader.locator('#my-play .playing-card').first().waitFor();
    assert.equal(await leader.locator('#table-event').isVisible(), false, 'refresh never replays a combo');
  }
  assert.deepEqual(errors, []);
  console.log('All 11 special combos passed: legal UI plays, three-client sync, animated artwork, desktop/mobile bounds, stable layout, reduced motion, and no replay on reload.');
} finally { await browser.close(); await game.close(); }
