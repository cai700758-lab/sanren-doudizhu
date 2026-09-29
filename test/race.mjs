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
  await page.locator('[data-action="play"]:not([disabled])').click();
  const drawn = owner.hand.find(card => !previousCards.has(card.id));
  assert.ok(drawn, 'one card is drawn from the second deck');
  const newCard = page.locator(`#hand [data-card-id="${drawn.id}"]`);
  await newCard.waitFor({ state: 'visible' });
  await page.waitForFunction(id => document.querySelector(`#hand [data-card-id="${id}"]`)?.classList.contains('just-drawn'), drawn.id);
  const reveal = await newCard.evaluate(node => ({
    visible: getComputedStyle(node).visibility,
    selected: node.getAttribute('aria-pressed'),
    hasLift: node.getAnimations().some(animation => animation.effect?.getKeyframes().some(frame => frame.transform === 'translateY(-16px)')),
  }));
  assert.equal(reveal.visible, 'visible', 'the drawn card face is visible immediately');
  assert.equal(reveal.selected, 'false', 'drawn-card highlight differs from selection');
  assert.equal(reveal.hasLift, true, 'new card lifts and settles in its sorted position');
  await page.waitForFunction(id => getComputedStyle(document.querySelector(`#hand [data-card-id="${id}"]`)).backgroundColor === 'rgb(233, 255, 246)', drawn.id);
  for (const viewer of pages) assert.equal(await viewer.locator('.race-draw-card').count(), 0, 'no card backs fly across the table');
  await page.screenshot({ path: 'test-results/race-draw-highlight.png' });
  await newCard.click({ position: { x: 9, y: 10 } });
  assert.equal(await newCard.getAttribute('aria-pressed'), 'true', 'a newly drawn card can be selected immediately');
  assert.equal(await newCard.evaluate(node => node.classList.contains('just-drawn')), false, 'selection replaces the draw highlight');
  await page.waitForFunction(() => document.querySelector('.draw-count')?.textContent === '53 张');
  assert.equal(owner.hand.length, 18); assert.equal(owner.playedCount, 1);
  assert.ok((await page.locator('#scores').textContent()).includes('已打 1/48'));
  for (const other of pages.filter(item => item !== page)) {
    await other.waitForFunction(() => document.querySelector('#scores')?.textContent.includes('已打 1/48'));
    assert.equal(await other.locator('#hand .playing-card').count(), 18);
  }
  for (const viewer of pages) {
    assert.equal(await viewer.locator('.player-info .avatar-progress .race-progress').count(), 3);
    assert.equal(await viewer.locator('.seat-status .race-progress').count(), 0);
    assert.equal(await viewer.locator(`.player-info[data-player-id="${owner.id}"] .race-progress`).textContent(), '1/48');
  }
  const passer = room.players[room.turn], passerPage = pages[room.turn];
  const passerCards = new Set(passer.hand.map(card => card.id));
  await passerPage.locator('[data-action="pass"]:not([disabled])').click();
  const passDrawn = passer.hand.find(card => !passerCards.has(card.id));
  assert.ok(passDrawn, 'passing draws a card');
  await passerPage.waitForFunction(id => document.querySelector(`#hand [data-card-id="${id}"]`)?.classList.contains('just-drawn'), passDrawn.id);
  assert.equal(await passerPage.locator('#hand .playing-card').count(), 19);
  assert.equal(await passerPage.locator('#my-play .pass-label').textContent(), '不出');
  assert.ok((await passerPage.locator('#my-play .play-caption').textContent()).includes('摸 1 张'));
  assert.equal(await passerPage.locator(`.player-info[data-player-id="${passer.id}"] .race-progress`).textContent(), '0/48');
  for (const viewer of pages.filter(item => item !== passerPage)) {
    await viewer.waitForFunction(id => document.querySelector(`.player-info[data-player-id="${id}"]`)?.closest('.player-slot')?.querySelectorAll('.facedown-card').length === 19, passer.id);
  }
  await page.waitForFunction(id => !document.querySelector(`#hand [data-card-id="${id}"]`)?.classList.contains('just-drawn'), drawn.id);
  await page.screenshot({ path: 'test-results/race-desktop.png', animations: 'disabled' });
  for (const viewport of [{ width: 320, height: 667 }, { width: 375, height: 667 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(180);
    const geometry = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, viewportWidth: innerWidth, viewportHeight: innerHeight }));
    assert.ok(geometry.width <= geometry.viewportWidth && geometry.height <= geometry.viewportHeight, JSON.stringify(geometry));
    if (viewport.width === 320) await page.screenshot({ path: 'test-results/race-mobile.png', animations: 'disabled' });
  }
  await page.screenshot({ path: 'test-results/race-landscape.png', animations: 'disabled' });
  for (const viewport of [{ width: 320, height: 667 }, { width: 844, height: 390 }]) {
    await passerPage.setViewportSize(viewport);
    await passerPage.waitForTimeout(180);
    const geometry = await passerPage.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, viewportWidth: innerWidth, viewportHeight: innerHeight }));
    assert.ok(geometry.width <= geometry.viewportWidth && geometry.height <= geometry.viewportHeight, `19-card hand: ${JSON.stringify(geometry)}`);
    await passerPage.screenshot({ path: viewport.width === 320 ? 'test-results/race-pass-mobile.png' : 'test-results/race-pass-landscape.png', animations: 'disabled' });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  clearTimeout(room.timer); room.turn = lead; room.lastPlay = null; room.actionAt = 0; owner.playedCount = 47;
  await page.reload(); await page.locator('[data-action="hint"]:not([disabled])').waitFor();
  await page.locator('[data-action="hint"]').click();
  await page.locator('[data-action="play"]:not([disabled])').click();
  await page.waitForFunction(() => document.querySelector('.arena')?.dataset.phase === 'finished');
  assert.equal(room.result.winnerId, owner.id);
  assert.equal(await page.locator('.race-draw-card').count(), 0, 'reduced motion does not create flying cards');
  assert.equal(await page.locator('#hand .just-drawn').count(), 1, 'reduced motion keeps the visible draw highlight');
  assert.equal(await page.locator('#hand .just-drawn').evaluate(node => node.getAnimations().length), 0, 'reduced motion does not lift cards');
  assert.ok((await page.locator('#selection-message').textContent()).includes('率先打出48张'));
  assert.deepEqual(errors, []);
  console.log('Race UI passed: 48-card target, private draw on play and pass, visible draw highlight, avatar progress, responsive 19-card hand and result.');
} finally { await browser.close(); await game.close(); }
