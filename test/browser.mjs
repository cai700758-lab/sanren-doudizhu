import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createGameServer } from '../server.js';
import { makeDeck } from '../lib/game.js';
import { createRoom, joinRoom } from './lobby-helper.mjs';
const game = createGameServer();
await new Promise(resolve => game.httpServer.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${game.httpServer.address().port}`;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  await fs.mkdir('test-results', { recursive: true });
const errors = [];
async function checkPlayedCardBounds(page, label) {
  for (const viewport of [
    { width: 320, height: 812 }, { width: 375, height: 667 },
    { width: 1280, height: 800 }, { width: 1366, height: 768 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(160);
    const bounds = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.player-play .playing-card')];
      return {
        count: cards.length,
        overflow: document.documentElement.scrollHeight > innerHeight,
        clipped: cards.filter(card => {
          const box = card.getBoundingClientRect();
          const zone = card.closest('.player-play').getBoundingClientRect();
          const scroller = card.closest('.table-cards');
          const scrollBox = scroller.getBoundingClientRect();
          const index = card.querySelector('.card-index').getBoundingClientRect();
          return box.top < zone.top || box.bottom + 2 > zone.bottom ||
            box.top < scrollBox.top || box.bottom + 2 > scrollBox.top + scroller.clientHeight ||
            index.top < box.top || index.bottom > box.bottom - 1;
        }).map(card => card.getAttribute('aria-label')),
      };
    });
    assert.ok(bounds.count > 0, `${label}: check actual played cards`);
    assert.deepEqual(bounds.clipped, [], `${label}: clipped cards at ${viewport.width}x${viewport.height}`);
    assert.equal(bounds.overflow, false, `${label}: full table fits at ${viewport.width}x${viewport.height}`);
    if (viewport.width === 375 || viewport.width === 1366) {
      await page.screenshot({ path: `test-results/${label}-${viewport.width}.png`, fullPage: true });
    }
  }
}
try {
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport: { width: 1440, height: 1000 } })));
  for (const context of contexts) await context.addInitScript(() => {
    window.vibrationRequests = [];
    window.soundStarts = [];
    for (const Type of [window.OscillatorNode, window.AudioBufferSourceNode]) {
      if (!Type) continue;
      const start = Type.prototype.start;
      Type.prototype.start = function (...args) { window.soundStarts.push(Type.name); return start.apply(this, args); };
    }
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: pattern => { window.vibrationRequests.push(pattern); return true; } });
  });
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const page of pages) page.on('pageerror', error => errors.push(error.message));
  const a = pages[0];
  await a.goto(url); await a.locator('#create-button').waitFor();
  await a.screenshot({ path: 'test-results/lobby-desktop.png', fullPage: true });
  async function layout(page, width, state) {
    await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(160);
    const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(dims.scroll <= dims.viewport, `${state}: overflow at ${width}`);
    const clippedButtons = await page.locator('button:visible').evaluateAll(buttons => buttons.filter(b => b.scrollWidth > b.clientWidth + 2).map(b => b.textContent));
    assert.deepEqual(clippedButtons, [], `${state}: clipped buttons at ${width}`);
    if (state === 'lobby') {
      const bounds = await page.locator('.entry-panel').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `entry panel clipped at ${width}`);
    }
    if (state === 'table') {
      assert.equal(await page.locator('.arena .character').count(), 3, 'each seat has a character');
      const fans = await page.locator('.opponent-hand').evaluateAll(hands => hands.map(hand => {
        const cards = hand.querySelectorAll('.facedown-card');
        const box = hand.getBoundingClientRect();
        const last = cards[cards.length - 1].getBoundingClientRect();
        return { count: cards.length, label: hand.getAttribute('aria-label'), fits: last.right <= box.right + 1 };
      }));
      assert.equal(fans.length, 2);
      for (const fan of fans) {
        assert.ok(fan.label.includes(`${fan.count} 张`), 'back cards match the public hand count');
        assert.ok(fan.fits, `opponent hand clipped at ${width}`);
      }
    }
    await page.screenshot({ path: `test-results/${state}-${width}.png`, fullPage: true });
  }
  for (const width of [320, 375, 414, 768, 1280]) await layout(a, width, 'lobby');
  await a.setViewportSize({ width: 1440, height: 1000 });
  // Exercise actual press geometry and optional feedback, independently of game rules.
  const create = a.locator('#create-button');
  await create.hover(); await a.mouse.down(); await a.waitForTimeout(120);
  const pressedY = await create.evaluate(button => new DOMMatrix(getComputedStyle(button).transform).m42);
  assert.equal(pressedY, 4, 'primary button should physically depress');
  await a.mouse.move(240, 40); await a.mouse.up();
  assert.ok(await a.evaluate(() => window.vibrationRequests.length > 0));
  await a.locator('#feedback-dialog').evaluate(dialog => dialog.showModal());
  await a.locator('#sound-toggle').check();
  await a.locator('#haptics-toggle').uncheck();
  await a.reload();
  await a.locator('#feedback-dialog').evaluate(dialog => dialog.showModal());
  assert.equal(await a.locator('#sound-toggle').isChecked(), true);
  assert.equal(await a.locator('#haptics-toggle').isChecked(), false);
  assert.equal(await a.evaluate(() => window.vibrationRequests.length), 0, 'vibration preference survives reload');
  await a.locator('#haptics-toggle').check();
  await a.locator('#sound-toggle').uncheck();
  await a.locator('#feedback-dialog [data-close]').click();
  await a.emulateMedia({ reducedMotion: 'reduce' });
  const vibrationsBefore = await a.evaluate(() => window.vibrationRequests.filter(request => request !== 0).length);
  await a.locator('#feedback-dialog').evaluate(dialog => dialog.showModal());
  assert.equal(await a.evaluate(() => window.vibrationRequests.filter(request => request !== 0).length), vibrationsBefore, 'reduced motion suppresses vibration');
  await a.locator('#feedback-dialog [data-close]').click();
  await a.emulateMedia({ reducedMotion: 'no-preference' });
  const unsupported = await browser.newContext();
  await unsupported.addInitScript(() => Object.defineProperty(navigator, 'vibrate', { value: undefined, configurable: true }));
  const fallback = await unsupported.newPage();
  await fallback.goto(url); await fallback.locator('#feedback-dialog').evaluate(dialog => dialog.showModal());
  assert.equal(await fallback.locator('#haptics-toggle').isDisabled(), true);
  await unsupported.close();
  await a.locator('#nickname').fill('阿青'); await createRoom(a);
  await a.locator('#game').waitFor({ state: 'visible' });
  const code = await a.locator('#room-title').textContent();
  await a.locator('#invite-button').click();
  assert.ok((await a.locator('#invite-link').inputValue()).includes(`room=${code}`));
  await a.locator('#invite-dialog [data-close]').click();
  for (let i = 1; i < 3; i++) {
    await pages[i].goto(`${url}/?room=${code}`); await pages[i].locator('#nickname').fill(['', '小满', '老周'][i]);
    await joinRoom(pages[i], code);
    await pages[i].locator('#game').waitFor({ state: 'visible' });
  }
  for (const page of pages) await page.locator('[data-action="ready"]').click();
  await a.waitForFunction(() => ['shuffle', 'deal'].includes(document.querySelector('.arena').dataset.motion));
  assert.ok(await a.locator('#animation-layer .shuffle-deck').isVisible());
  assert.ok(await a.locator('#hand .playing-card').evaluateAll(cards => cards.some(card => card.getAnimations().length > 0)), 'deal animates actual cards');
  await a.screenshot({ path: 'test-results/shuffle-animation.png', fullPage: true });
  const bidPage = await (async () => {
    for (let i = 0; i < 50; i++) {
      for (const page of pages) if (await page.locator('[data-action="bid-3"]').isVisible()) return page;
      await a.waitForTimeout(50);
    }
    throw new Error('No bidder');
  })();
  await bidPage.waitForFunction(() => !document.querySelector('.arena').dataset.motion);
  await bidPage.locator('[data-action="bid-3"]').click();
  await bidPage.locator('[data-action="hint"]').waitFor();
  assert.equal(await bidPage.locator('#hand .playing-card').count(), 20);
  const handRanks = await bidPage.locator('#hand .playing-card').evaluateAll(cards => cards.map(card => Number(card.dataset.rank)));
  assert.deepEqual(handRanks, [...handRanks].sort((a, b) => a - b));
  await bidPage.screenshot({ path: 'test-results/table-desktop.png', fullPage: true });
  for (const width of [320, 375, 414, 768, 1280]) await layout(bidPage, width, 'table');
  for (const { width, height } of [
    { width: 320, height: 812 }, { width: 375, height: 667 },
    { width: 414, height: 896 }, { width: 1280, height: 800 },
    { width: 1366, height: 768 },
  ]) {
    await bidPage.setViewportSize({ width, height }); await bidPage.waitForTimeout(160);
    const pageHeight = await bidPage.evaluate(() => document.documentElement.scrollHeight);
    assert.ok(pageHeight <= height, `table needs vertical scrolling at ${width}x${height}: ${pageHeight}px`);
    const roles = bidPage.locator('.arena .player-role');
    assert.equal(await roles.count(), 3, 'all players have visible role badges');
    assert.equal(await roles.locator('svg').count(), 3, 'each player role has an icon');
  }
  await bidPage.setViewportSize({ width: 1440, height: 1000 });
  await bidPage.reload(); await bidPage.locator('[data-action="hint"]').waitFor();
  assert.equal(await bidPage.locator('#hand .playing-card').count(), 20);
  async function swipe(page, from, to, touch = false, cancel = false) {
    const first = await page.locator('#hand [data-card]').nth(from).boundingBox();
    const last = await page.locator('#hand [data-card]').nth(to).boundingBox();
    const start = { x: first.x + 8, y: first.y + first.height / 2 };
    const end = { x: last.x + 8, y: last.y + last.height / 2 };
    if (touch) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
      await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 1 }); await page.mouse.up();
    }
    await page.waitForTimeout(160);
  }
  await swipe(bidPage, 0, 4);
  assert.equal(await bidPage.locator('#hand [aria-pressed="true"]').count(), 5, 'fast drag selects crossed cards');
  await swipe(bidPage, 4, 0);
  assert.equal(await bidPage.locator('#hand [aria-pressed="true"]').count(), 0, 'reverse drag cancels selection');
  await bidPage.locator('#hand [data-card]').first().focus(); await bidPage.keyboard.press('Space');
  assert.equal(await bidPage.locator('#hand [aria-pressed="true"]').count(), 1);
  await bidPage.keyboard.press('Space');
  assert.equal(await bidPage.locator('#hand [aria-pressed="true"]').count(), 0);
  await bidPage.locator('[data-action="hint"]').click();
  assert.equal(await bidPage.locator('#hand [aria-pressed="true"]').count(), 1);
  await bidPage.locator('[data-action="play"]').click();
  await bidPage.waitForFunction(() => document.querySelectorAll('#hand .playing-card').length === 19);
  assert.equal(await bidPage.locator('#my-play .playing-card').count(), 1);
  assert.equal(await bidPage.locator('#table-center .playing-card').count(), 0);
  for (const page of pages.filter(page => page !== bidPage)) {
    await page.waitForFunction(() => document.querySelectorAll('.opponent-plays .playing-card').length === 1);
  }
  await bidPage.waitForTimeout(350);
  await bidPage.screenshot({ path: 'test-results/played-at-seat.png', fullPage: true });
  await bidPage.reload(); await bidPage.locator('#my-play .playing-card').waitFor();
  assert.equal(await bidPage.locator('#my-play .playing-card').count(), 1, 'played cards survive refresh');
  await checkPlayedCardBounds(bidPage, 'complete-play');
  const stableGeometry = () => bidPage.evaluate(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.top + scrollY, r.height]; };
    return { arena: box('.arena'), actions: box('#actions'), hand: box('#hand') };
  });
  const beforePass = await stableGeometry();
  const geometryByWidth = new Map();
  for (const width of [320, 375, 414, 768, 1280]) {
    await bidPage.setViewportSize({ width, height: 900 }); await bidPage.waitForTimeout(160);
    geometryByWidth.set(width, await stableGeometry());
  }
  await bidPage.setViewportSize({ width: 1440, height: 1000 }); await bidPage.waitForTimeout(160);
  const room = game.rooms.get(code);
  const pageForTurn = () => pages[room.turn];
  for (let i = 0; i < 2; i++) {
    const actor = pageForTurn();
    await actor.locator('[data-action="pass"]:not([disabled])').click();
    await actor.locator('#my-play .pass-label').waitFor();
    assert.equal(await actor.locator('#my-play .pass-label').textContent(), '不出');
  }
  await bidPage.locator('[data-action="hint"]:not([disabled])').waitFor();
  assert.deepEqual(await stableGeometry(), beforePass, 'empty and occupied play areas keep identical geometry');
  for (const [width, geometry] of geometryByWidth) {
    await bidPage.setViewportSize({ width, height: 900 }); await bidPage.waitForTimeout(160);
    assert.deepEqual(await stableGeometry(), geometry, `passing preserves layout at ${width}px`);
  }
  await bidPage.setViewportSize({ width: 1440, height: 1000 }); await bidPage.waitForTimeout(160);
  assert.equal(await bidPage.locator('.opponent-plays .pass-label').count(), 2);
  await bidPage.screenshot({ path: 'test-results/passes-at-seats.png', fullPage: true });
  // A real bomb followed by one remaining card exercises the event sequence on all clients.
  const bomb = makeDeck().filter(card => card.rank === 3);
  room.players[room.turn].hand = [...bomb, makeDeck().find(card => card.rank === 4)];
  await bidPage.reload(); await bidPage.locator('[data-action="hint"]:not([disabled])').waitFor();
  await bidPage.locator('#feedback-button').click(); await bidPage.locator('#sound-toggle').check();
  await bidPage.locator('#feedback-dialog [data-close]').click();
  await bidPage.emulateMedia({ reducedMotion: 'reduce' });
  for (const card of bomb) await bidPage.locator(`#hand [data-card="${card.id}"]`).click({ position: { x: 8, y: 15 } });
  const soundsBeforeBomb = await bidPage.evaluate(() => window.soundStarts.length);
  await bidPage.locator('[data-action="play"]:not([disabled])').click();
  await bidPage.locator('#table-event[data-event="bomb"]:visible').waitFor();
  assert.ok(await bidPage.evaluate(before => window.soundStarts.length >= before + 3, soundsBeforeBomb), 'bomb plays layered audio');
  assert.equal(await bidPage.locator('.event-card').evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.deepEqual(await stableGeometry(), beforePass, 'special events do not move the table');
  await bidPage.screenshot({ path: 'test-results/bomb-event.png', fullPage: true });
  await bidPage.locator('#table-event[data-event="warning"]:visible').waitFor();
  assert.ok((await bidPage.locator('#table-event').textContent()).includes('仅剩 1 张'));
  await bidPage.locator('#feedback-button').click(); await bidPage.locator('#sound-toggle').uncheck();
  await bidPage.locator('#feedback-dialog [data-close]').click();
  const soundsAfterMute = await bidPage.evaluate(() => window.soundStarts.length);
  await bidPage.emulateMedia({ reducedMotion: 'no-preference' });
  for (let i = 0; i < 2; i++) await pageForTurn().locator('[data-action="pass"]:not([disabled])').click();
  await bidPage.locator('[data-action="hint"]:not([disabled])').waitFor();
  const winningCard = room.players[room.turn].hand.at(-1);
  room.players[room.turn].hand = [winningCard];
  await bidPage.locator(`#hand [data-card="${winningCard.id}"]`).focus();
  await bidPage.keyboard.press('Space');
  await bidPage.locator('[data-action="play"]:not([disabled])').click();
  await bidPage.waitForFunction(() => document.querySelector('.arena').dataset.phase === 'finished');
  await bidPage.locator('#table-event[data-event="win"]:visible').waitFor();
  assert.ok((await bidPage.locator('.event-score').textContent()).startsWith('+'));
  assert.equal(await bidPage.evaluate(() => window.soundStarts.length), soundsAfterMute, 'mute suppresses subsequent turn and result audio');
  await bidPage.screenshot({ path: 'test-results/victory-event.png', fullPage: true });
  assert.deepEqual(await stableGeometry(), beforePass, 'end of round preserves table and hand geometry');
  assert.equal(await bidPage.locator('.opponent-plays .revealed-hand').count(), 2);
  assert.equal(await bidPage.locator('.revealed-hand .playing-card').count(), room.players.filter(p => p.id !== room.landlordId).reduce((sum, p) => sum + p.hand.length, 0));
  for (const page of pages.slice(0, 2)) await page.locator('[data-action="ready"]').click();
  assert.equal(room.phase, 'finished');
  await bidPage.reload();
  await bidPage.locator('.revealed-hand .playing-card').first().waitFor();
  await checkPlayedCardBounds(bidPage, 'complete-revealed-hands');
  await bidPage.screenshot({ path: 'test-results/round-finished.png', fullPage: true });
  await bidPage.setViewportSize({ width: 320, height: 900 }); await bidPage.waitForTimeout(160);
  assert.ok(await bidPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await bidPage.screenshot({ path: 'test-results/round-finished-320.png', fullPage: true });
  // Refresh disconnects the seat and cancels its readiness; explicitly ready it again.
  for (let i = 0; i < 2; i++) if (!room.players[i].ready) await pages[i].locator('[data-action="ready"]').click();
  await pages[2].locator('[data-action="ready"]').click();
  await bidPage.waitForFunction(() => document.querySelector('.arena').dataset.phase === 'bidding');
  assert.equal(await bidPage.locator('.revealed-hand').count(), 0);
  await a.locator('#rules-button').click(); await a.locator('#rules-dialog').waitFor({ state: 'visible' });
  await a.keyboard.press('Escape'); assert.equal(await a.locator('#rules-dialog').isVisible(), false);
  await a.locator('#chat-button').click(); await a.locator('[data-chat="2"]').click();
  await pages[1].getByRole('status').filter({ hasText: '打得漂亮' }).waitFor();
  const soloContext = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const solo = await soloContext.newPage();
  solo.on('pageerror', error => errors.push(error.message));
  await solo.goto(url); await solo.locator('#nickname').fill('单人玩家'); await createRoom(solo);
  await solo.locator('[data-action="fill-bots"]').click();
  await solo.waitForFunction(() => document.querySelectorAll('[data-action="remove-bot"]').length === 2);
  await solo.screenshot({ path: 'test-results/bots-mobile.png', fullPage: true });
  await solo.locator('[data-action="remove-bot"]').first().click();
  await solo.waitForFunction(() => document.querySelectorAll('[data-action="remove-bot"]').length === 1);
  await solo.locator('[data-action="fill-bots"]').click();
  await solo.locator('[data-action="ready"]').click();
  await solo.waitForFunction(() => document.querySelector('[data-action="bid-3"]') || document.querySelector('#round-label').textContent.includes('对局中'));
  if (await solo.locator('[data-action="bid-3"]').isVisible()) await solo.locator('[data-action="bid-3"]').click();
  await solo.locator('[data-action="hint"]:not([disabled])').waitFor();
  assert.ok([17, 20].includes(await solo.locator('#hand .playing-card').count()));
  await solo.waitForTimeout(400);
  await swipe(solo, 0, 4, true);
  assert.equal(await solo.locator('#hand [aria-pressed="true"]').count(), 5, 'touch swipe selects cards');
  await swipe(solo, 4, 0, true);
  assert.equal(await solo.locator('#hand [aria-pressed="true"]').count(), 0);
  await swipe(solo, 0, 3, true, true);
  assert.equal(await solo.locator('#hand [aria-pressed="true"]').count(), 0, 'cancelled touch gesture restores selection');
  await swipe(solo, 9, 10, true);
  assert.equal(await solo.locator('#hand [data-card]').nth(9).getAttribute('aria-pressed'), 'true');
  assert.equal(await solo.locator('#hand [data-card]').nth(10).getAttribute('aria-pressed'), 'true');
  await solo.locator('[data-action="clear"]').click();
  await solo.locator('[data-action="hint"]').click();
  if (await solo.locator('[data-action="play"]').isEnabled()) await solo.locator('[data-action="play"]').click();
  else await solo.locator('[data-action="pass"]').click();
  await solo.locator('[data-action="hint"]:not([disabled])').waitFor();
  assert.equal(await solo.locator('[data-action="remove-bot"]').count(), 0, 'bot removal is unavailable during play');
  await soloContext.close();
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: three-human and bot games; public remaining hands until all ready; large per-seat passes; identical table/hand/control geometry across play and pass states at 320/375/414/768/1280px; ascending cards; reload; mouse, touch, cross-row swipe, cancellation and keyboard selection; shuffle/deal animations; feedback settings and reduced motion. Hardware vibration is not tested.');
} finally { await browser.close(); await game.close(); }
