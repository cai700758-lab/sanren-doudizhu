import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createGameServer } from '../server.js';
import { joinRoom } from './lobby-helper.mjs';

const game = createGameServer({ dealDelayMs: 0, actionDelayMs: 0, turnMs: 120000 });
await new Promise(resolve => game.httpServer.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${game.httpServer.address().port}`;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const pages = [], errors = [];
await fs.mkdir('test-results', { recursive: true });
try {
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.locator('#nickname').fill(['阿青', '小满', '老周'][i]);
    if (!i) {
      await page.locator('#create-button').click();
      await page.locator('[name="room-size"][value="4"]').check({ force: true });
      assert.equal(await page.locator('[name="room-kind"][value="race"]').isDisabled(), true);
      await page.locator('[name="room-size"][value="3"]').check({ force: true });
      await page.locator('.race-choice').click();
      await page.locator('#create-confirm').click();
    } else await joinRoom(page, await pages[0].locator('#room-title').textContent());
    await page.locator('#game').waitFor({ state: 'visible' });
    assert.ok(await page.locator('body').evaluate(node => node.classList.contains('race-mode')));
  }
  for (const page of pages) await page.locator('[data-action="ready"]').click();
  const room = game.rooms.get(await pages[0].locator('#room-title').textContent());
  const lead = room.turn, page = pages[lead], owner = room.players[lead];
  await page.locator('[data-action="hint"]:not([disabled])').waitFor();
  assert.equal(await page.locator('#hand .playing-card').count(), 18);
  assert.equal(await page.locator('#bottom-label').textContent(), '抽牌堆');
  assert.equal(await page.locator('.draw-count').textContent(), '54 张');
  assert.ok((await page.locator('#selection-message').textContent()).includes('红桃3'));
  await page.locator('[data-action="hint"]').click();
  assert.equal(await page.locator('#hand [aria-pressed="true"]').count(), 1);
  assert.equal(await page.locator('#hand [aria-pressed="true"]').getAttribute('data-card'), '1');
  const previousCards = new Set(owner.hand.map(card => card.id));
  const faceHiddenDuringFlight = page.evaluate(() => new Promise(resolve => {
    const layer = document.querySelector('#animation-layer');
    const observer = new MutationObserver(() => {
      if (!layer.querySelector('.race-draw-card')) return;
      observer.disconnect();
      resolve([...document.querySelectorAll('#hand [data-card-id]')].some(node => getComputedStyle(node).visibility === 'hidden'));
    });
    observer.observe(layer, { childList: true });
    setTimeout(() => { observer.disconnect(); resolve(false); }, 4000);
  }));
  const flightStarts = pages.map(viewer => viewer.locator('.race-draw-card.back').first().waitFor({ timeout: 4000 }));
  await page.locator('[data-action="play"]:not([disabled])').click();
  assert.equal(await faceHiddenDuringFlight, true, 'new card face stays hidden while the back flies in');
  await Promise.all(flightStarts);
  const drawn = owner.hand.find(card => !previousCards.has(card.id));
  assert.ok(drawn, 'one card is drawn from the second deck');
  await page.screenshot({ path: 'test-results/race-draw-flight.png' });
  await page.locator('.race-draw-card').first().waitFor({ state: 'detached', timeout: 4000 });
  assert.equal(await page.locator(`#hand [data-card-id="${drawn.id}"]`).evaluate(node => getComputedStyle(node).visibility), 'visible');
  await page.waitForFunction(() => document.querySelector('.draw-count')?.textContent === '53 张');
  assert.equal(owner.hand.length, 18); assert.equal(owner.playedCount, 1);
  assert.ok((await page.locator('#scores').textContent()).includes('已打 1/30'));
  for (const other of pages.filter(item => item !== page)) {
    await other.waitForFunction(() => document.querySelector('#scores')?.textContent.includes('已打 1/30'));
    assert.equal(await other.locator('#hand .playing-card').count(), 18);
  }
  for (const viewer of pages) {
    assert.equal(await viewer.locator('.player-info .avatar-progress .race-progress').count(), 3);
    assert.equal(await viewer.locator('.seat-status .race-progress').count(), 0);
    assert.equal(await viewer.locator(`.player-info[data-player-id="${owner.id}"] .race-progress`).textContent(), '1/30');
  }
  await page.screenshot({ path: 'test-results/race-desktop.png', animations: 'disabled' });
  for (const viewport of [{ width: 320, height: 667 }, { width: 375, height: 667 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(180);
    const geometry = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, viewportWidth: innerWidth, viewportHeight: innerHeight }));
    assert.ok(geometry.width <= geometry.viewportWidth && geometry.height <= geometry.viewportHeight, JSON.stringify(geometry));
    if (viewport.width === 320) await page.screenshot({ path: 'test-results/race-mobile.png', animations: 'disabled' });
  }
  await page.screenshot({ path: 'test-results/race-landscape.png', animations: 'disabled' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  clearTimeout(room.timer); room.turn = lead; room.lastPlay = null; room.actionAt = 0; owner.playedCount = 29;
  await page.reload(); await page.locator('[data-action="hint"]:not([disabled])').waitFor();
  await page.locator('[data-action="hint"]').click();
  await page.locator('[data-action="play"]:not([disabled])').click();
  await page.waitForFunction(() => document.querySelector('.arena')?.dataset.phase === 'finished');
  assert.equal(room.result.winnerId, owner.id);
  assert.equal(await page.locator('.race-draw-card').count(), 0, 'reduced motion updates the hand without flying cards');
  assert.ok((await page.locator('#selection-message').textContent()).includes('率先打出30张'));
  assert.deepEqual(errors, []);
  console.log('Race UI passed: mode creation, first-heart-three hint, private draw flights and face reveal, avatar progress, three-seat sync, responsive layout and 30-card result.');
} finally { await browser.close(); await game.close(); }
