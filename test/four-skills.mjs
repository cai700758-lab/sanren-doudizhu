import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createGameServer } from '../server.js';
import { makeDeck } from '../lib/game.js';
import { createRoom } from './lobby-helper.mjs';
const game = createGameServer({ dealDelayMs: 0, actionDelayMs: 0, botDelayMs: 600000, turnMs: 600000 });
await new Promise(resolve => game.httpServer.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${game.httpServer.address().port}`;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
await fs.mkdir('test-results', { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 320, height: 667 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  assert.equal(await page.locator('#lobby input').count(), 1, 'initial lobby only asks for nickname');
  assert.equal(await page.locator('.entry-actions button').count(), 2);
  assert.equal(await page.locator('#create-dialog').isVisible(), false);
  assert.equal(await page.locator('.site-header nav').isVisible(), false);
  await page.screenshot({ path: 'test-results/lobby-simple-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: 'test-results/lobby-simple-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 667 });
  await page.locator('#nickname').fill('四人技能试玩');
  await page.locator('#create-button').click();
  assert.equal(await page.locator('#create-dialog').isVisible(), true);
  assert.equal(await page.locator('#create-options input:checked').count(), 2);
  await page.locator('#create-dialog [data-close]').click();
  assert.equal(await page.locator('#lobby input').count(), 1);
  await createRoom(page, { players: 4, skills: true });
  const code = await page.locator('#room-title').textContent(), room = game.rooms.get(code);
  assert.equal(room.mode, 'fourSkills'); assert.ok((await page.locator('#round-label').textContent()).includes('四人技能'));
  await page.locator('[data-action="fill-bots"]').click(); await page.locator('[data-action="ready"]').click();
  await page.locator('#hand .playing-card').first().waitFor(); clearTimeout(room.timer);
  const deck = makeDeck('fourSkills');
  room.phase = 'playing'; room.turn = 0; room.landlordId = room.players[0].id;
  room.players[0].skill = { id: 'gift', used: false, choices: null };
  room.players[0].hand = [...deck.slice(0, 33), ...deck.slice(33, 43).map((card, i) => ({ ...card, id: 108 + i }))];
  await page.reload(); await page.locator('#hand .playing-card').first().waitFor();
  assert.equal(await page.locator('#hand .playing-card').count(), 43);
  assert.equal(await page.locator('#top-player .role-bot').count(), 1);
  assert.equal(await page.locator('#hand .hand-row').count(), 2);
  for (const [width, height] of [[320, 667], [375, 667], [414, 896], [568, 320], [844, 390]]) {
    await page.setViewportSize({ width, height }); await page.waitForTimeout(160);
    const geometry = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#hand .playing-card')];
      const skill = document.querySelector('#skill-dock').getBoundingClientRect();
      return { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
        cards: cards.every(card => { const r = card.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }),
        skill: skill.left >= 0 && skill.right <= innerWidth && skill.bottom <= innerHeight };
    });
    await page.screenshot({ path: `test-results/four-skills-${width}-${height}.png`, fullPage: true });
    assert.ok(geometry.width <= width && geometry.height <= height && geometry.cards && geometry.skill, `${width}x${height}: ${JSON.stringify(geometry)}`);
  }
  await page.setViewportSize({ width: 375, height: 667 }); await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.locator('#skill-button').click();
  assert.equal(await page.locator('#skill-target option').count(), 3);
  const recipient = room.players[2]; await page.locator('#skill-target').selectOption(recipient.id);
  const before = recipient.hand.length; await page.locator('[data-skill-use]').click();
  assert.equal(recipient.hand.length, before + 2);
  assert.equal(room.players[0].skill.used, true);
  assert.equal(await page.locator('.skill-announcement').isVisible(), true);
  assert.equal(await page.locator('.skill-motion-layer').getAttribute('data-target'), recipient.id);
  room.players[0].skill = { id: 'steal', used: false, choices: null };
  const actorCount = room.players[0].hand.length, targetCount = recipient.hand.length;
  await page.reload(); await page.locator('#skill-button:not([disabled])').waitFor();
  await page.locator('#skill-button').click();
  assert.equal(await page.locator('label[for="skill-target"]').textContent(), '从谁手中拿牌');
  assert.equal(await page.locator('#skill-target option').count(), 3);
  await page.locator('#skill-target').selectOption(recipient.id);
  await page.locator('[data-skill-use]').click();
  assert.equal(room.players[0].hand.length, actorCount + 2);
  assert.equal(recipient.hand.length, targetCount - 2);
  assert.equal(await page.locator('.skill-announcement[data-skill="steal"]').isVisible(), true);
  assert.equal(await page.locator('.skill-motion-layer').getAttribute('data-target'), recipient.id);
  assert.deepEqual(errors, []);
  console.log('Four-player skills UI: simplified lobby, mode setup, 43 cards, five portrait/landscape viewports, gift and steal targeting and animations passed.');
} finally { await browser.close(); await game.close(); }
