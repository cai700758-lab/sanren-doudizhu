import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createGameServer } from '../server.js';
import { createRoom, joinRoom } from './lobby-helper.mjs';
import { makeDeck, classify } from '../lib/game.js';

const game = createGameServer({ dealDelayMs: 0, actionDelayMs: 0 });
await new Promise(resolve => game.httpServer.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${game.httpServer.address().port}`;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const errors = [];
try {
  const pages = [];
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, hasTouch: true });
    await context.addInitScript(() => localStorage.setItem('sanren-sound', 'off'));
    const page = await context.newPage(); pages.push(page); page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.locator('#nickname').fill(`玩家${i + 1}`);
    if (!i) await createRoom(page);
    else await joinRoom(page, await pages[0].locator('#room-title').textContent());
    await page.locator('#game').waitFor({ state: 'visible' });
  }
  for (const page of pages) await page.locator('[data-action="ready"]').click();
  const room = game.rooms.get(await pages[0].locator('#room-title').textContent());
  const leaderIndex = room.turn, page = pages[leaderIndex];
  await page.locator('[data-action="bid-3"]:not([disabled])').click();
  async function seed(ranks, target = null) {
    const deck = makeDeck(), selected = ranks.map(rank => deck.splice(deck.findIndex(card => card.rank === rank), 1)[0]);
    room.players[leaderIndex].hand = [...selected, ...deck.slice(-2)];
    room.turn = leaderIndex; room.actionAt = 0; room.tablePlays = {}; room.tablePasses = {};
    room.lastPlay = target ? { playerId: room.players[(leaderIndex + 1) % 3].id, cards: target, combo: classify(target) } : null;
    await page.reload(); await page.locator('[data-action="hint"]:not([disabled])').waitFor();
    return selected;
  }
  const selectedRanks = () => page.locator('#hand [aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.rank)));
  async function keyboardSelect(cards) {
    for (const card of cards) { await page.locator(`#hand [data-card="${card.id}"]`).focus(); await page.keyboard.press('Space'); }
  }
  const straight = await seed([3, 4, 4, 5, 6, 7]);
  const revision = room.revision;
  await keyboardSelect(straight);
  assert.equal((await selectedRanks()).length, 6, 'selection is not changed mid-gesture');
  await page.locator('[data-action="undo-selection"]').waitFor();
  assert.deepEqual(await selectedRanks(), [3, 4, 5, 6, 7]);
  assert.equal(room.revision, revision, 'repair never plays cards or changes the server state');
  assert.equal(await page.locator('[data-action="play"]').isEnabled(), true);
  await page.locator('[data-action="undo-selection"]').click();
  await page.waitForTimeout(750);
  assert.deepEqual(await selectedRanks(), [3, 4, 4, 5, 6, 7], 'undo restores exactly and does not auto-repair again');
  await page.locator('[data-action="clear"]').click();
  await keyboardSelect(straight); await page.locator('[data-action="clear"]').click();
  await page.waitForTimeout(750); assert.deepEqual(await selectedRanks(), [], 'clear cancels pending repair');

  await page.setViewportSize({ width: 375, height: 667 });
  const plane = await seed([3, 3, 3, 4, 4, 4, 5]);
  const first = await page.locator(`#hand [data-card="${plane[0].id}"]`).boundingBox();
  const last = await page.locator(`#hand [data-card="${plane.at(-1).id}"]`).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: first.x + 8, y: first.y + 25 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: last.x + 8, y: last.y + 25 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
  await page.locator('[data-action="undo-selection"]').waitFor();
  assert.deepEqual(await selectedRanks(), [3, 3, 3, 4, 4, 4]);
  assert.ok((await page.locator('#selection-message').textContent()).includes('飞机'));
  assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight));
  assert.ok(await page.locator('#selection-message').evaluate(node => node.scrollWidth <= node.clientWidth), 'repair notice and undo fit on mobile');
  await fs.mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/smart-selection-mobile.png', fullPage: true });
  await page.locator('[data-action="undo-selection"]').click();
  assert.deepEqual(await selectedRanks(), [3, 3, 3, 4, 4, 4, 5], 'undo also works on mobile');
  const pairs = await seed([3, 3, 8, 8, 12], makeDeck().filter(card => card.rank === 6).slice(0, 2));
  await keyboardSelect(pairs); await page.locator('[data-action="undo-selection"]').waitFor();
  assert.deepEqual(await selectedRanks(), [8, 8]);
  const blocked = await seed([3, 4, 4, 5, 6, 7], makeDeck().filter(card => card.rank >= 16));
  await keyboardSelect(blocked); await page.waitForTimeout(750);
  assert.deepEqual(await selectedRanks(), [3, 4, 4, 5, 6, 7], 'no legal response preserves the manual selection');
  assert.equal(await page.locator('[data-action="play"]').isEnabled(), false);
  assert.deepEqual(errors, []);
  console.log('Smart selection passed: keyboard batching, touch sweep, straight/airplane repair, legal follow, no added cards or auto-play, undo, clear, and mobile fit.');
} finally { await browser.close(); await game.close(); }
