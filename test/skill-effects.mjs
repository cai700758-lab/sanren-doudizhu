import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createGameServer } from '../server.js';
import { createRoom, joinRoom } from './lobby-helper.mjs';
import { makeDeck, sortCards } from '../lib/game.js';
import { SKILLS } from '../lib/skills.js';

const game = createGameServer({ turnMs: 120000, dealDelayMs: 0, actionDelayMs: 0 });
await new Promise(resolve => game.httpServer.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${game.httpServer.address().port}`;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const pages = [], errors = [];
await fs.mkdir('test-results', { recursive: true });
try {
  for (let i = 0; i < 3; i++) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } }); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.locator('#nickname').fill(['阿青', '小满', '老周'][i]);
    if (!i) await createRoom(page, { skills: true });
    else await joinRoom(page, await pages[0].locator('#room-title').textContent());
    await page.locator('#game').waitFor({ state: 'visible' });
  }
  for (const page of pages) await page.locator('[data-action="ready"]').click();
  const room = game.rooms.get(await pages[0].locator('#room-title').textContent());
  const leader = room.turn, actor = pages[leader], p = room.players[leader];
  await actor.locator('[data-action="bid-3"]:not([disabled])').click();
  const recipient = room.players[(leader + 1) % 3];
  const reloadAll = async () => {
    await Promise.all(pages.map(async page => { await page.reload(); await page.locator('#skill-button:not([disabled])').waitFor(); }));
  };
  async function use(page) {
    await page.locator('#skill-button').click();
    if (await page.locator('#skill-target').count()) await page.locator('#skill-target').selectOption(recipient.id);
    await page.locator('[data-skill-use]:not([disabled])').click();
  }
  for (const id of ['gift', 'steal', 'wild', 'reroll', 'remove', 'clone', 'draw', 'draft', 'peek', 'upgrade']) {
    room.turn = leader; room.lastPlay = null; room.tablePlays = {}; room.tablePasses = {};
    p.hand = sortCards(makeDeck().slice(0, 17)); p.skill = { id, used: false, choices: null };
    if (id === 'gift') recipient.skill = { id: 'clone', used: false, choices: null };
    await reloadAll(); await use(actor);
    for (const page of pages) {
      await page.locator(`.skill-announcement[data-skill="${id}"]:not([hidden])`).waitFor();
      assert.ok((await page.locator('.skill-announcement').textContent()).includes(`${p.name} 使用了`));
      assert.equal(await page.locator('.skill-announcement-description').textContent(), SKILLS[id].description);
      assert.equal(await page.locator('.skill-announcement [data-skill-icon]').getAttribute('data-skill-icon'), id);
      assert.ok(await page.locator(`.skill-motion-layer .skill-fx-card[data-skill="${id}"]`).count());
    }
    if (id === 'gift' || id === 'steal') {
      for (const page of pages) {
        assert.equal(await page.locator('.skill-motion-layer').getAttribute('data-target'), recipient.id);
        assert.ok((await page.locator('.skill-announcement-result').textContent()).includes(recipient.name));
        const direction = await page.evaluate(({ targetId, actorId }) => {
          const seatCenter = playerId => {
            const zone = [...document.querySelectorAll('.player-play')].find(node => node.dataset.playerId === playerId);
            const box = document.querySelector(zone.id === 'my-play' ? '#hand' : zone.id === 'left-play' ? '#left-player .opponent-hand' : zone.id === 'top-play' ? '#top-player .opponent-hand' : '#right-player .opponent-hand').getBoundingClientRect();
            return [box.x + box.width / 2, box.y + box.height / 2];
          };
          const frames = document.querySelector('.skill-fx-card').getAnimations()[0].effect.getKeyframes();
          const matches = (frame, playerId) => {
            const xy = /translate\(([-.\d]+)px, ([-.\d]+)px\)/.exec(frame.transform), center = seatCenter(playerId);
            return Math.abs(Number(xy[1]) - center[0]) < 1 && Math.abs(Number(xy[2]) - center[1]) < 1;
          };
          return { gift: matches(frames[0], actorId) && matches(frames.at(-1), targetId), steal: matches(frames[0], targetId) && matches(frames.at(-1), actorId) };
        }, { targetId: recipient.id, actorId: p.id });
        assert.ok(direction[id], `${id} card flies in the correct direction in each viewer’s seat orientation`);
      }
      await actor.waitForTimeout(850);
      await pages[(leader + 2) % 3].screenshot({ path: `test-results/skill-${id}-flight.png` });
    }
    if (id === 'gift') {
      // Ordinary play and subsequent state updates must not wipe the skill notice.
      await actor.locator('#hand [data-card]').first().click({ position: { x: 8, y: 10 } });
      await actor.locator('[data-action="play"]:not([disabled])').click();
      await use(pages[(leader + 1) % 3]);
      await actor.waitForTimeout(3000);
      assert.ok(await actor.locator('.skill-announcement').isVisible(), 'readable for more than the old 1.5 seconds');
      for (const page of pages) {
        await page.locator('.skill-announcement[data-skill="clone"]:not([hidden])').waitFor({ timeout: 5000 });
        assert.ok((await page.locator('.skill-announcement').textContent()).includes(recipient.name), 'consecutive skills are queued, not overwritten');
      }
      await actor.locator('.skill-announcement').waitFor({ state: 'hidden', timeout: 6500 });
    }
    if (id === 'draft') {
      await actor.locator('[data-skill-choice]').first().click();
      for (const page of pages) {
        await page.waitForFunction(() => document.querySelector('.skill-announcement').dataset.stage === 'choice');
        assert.ok((await page.locator('.skill-announcement-result').textContent()).includes('已选取一张牌'));
      }
    }
  }
  // Long descriptions remain contained at the four required responsive widths.
  for (const viewport of [{ width: 320, height: 812 }, { width: 375, height: 667 }, { width: 414, height: 896 }, { width: 768, height: 900 }]) {
    await actor.setViewportSize(viewport);
    p.skill = { id: 'wild', used: false }; await actor.reload();
    await actor.locator('#skill-button:not([disabled])').waitFor(); await use(actor);
    await actor.locator('#skill-dialog [data-close]').click();
    const noticeLayout = await actor.locator('.skill-announcement').evaluate(node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight, contentWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollHeight: document.documentElement.scrollHeight };
    });
    assert.ok(noticeLayout.left >= 0 && noticeLayout.right <= noticeLayout.width && noticeLayout.top >= 0 && noticeLayout.bottom <= noticeLayout.height && noticeLayout.contentWidth <= noticeLayout.clientWidth && noticeLayout.scrollHeight <= noticeLayout.height, `${viewport.width}x${viewport.height}: ${JSON.stringify(noticeLayout)}`);
    if (viewport.width === 375) await actor.screenshot({ path: 'test-results/skill-notice-mobile.png' });
  }
  await actor.emulateMedia({ reducedMotion: 'reduce' });
  p.skill = { id: 'draw', used: false }; await actor.reload(); await actor.locator('#skill-button:not([disabled])').waitFor(); await use(actor);
  await actor.locator('.skill-announcement:not([hidden])').waitFor();
  assert.ok(await actor.locator('.skill-announcement').isVisible());
  assert.equal(await actor.locator('.skill-fx-card').count(), 0, 'reduced motion keeps explanation and suppresses flying cards');
  await actor.reload(); await actor.locator('#skill-button:not([disabled])').waitFor();
  assert.equal(await actor.locator('.skill-announcement').isVisible(), false, 'reconnect does not replay historical skills');
  assert.deepEqual(errors, []);
  console.log('Skill effects passed: ten skills broadcast to all three seats, directed gifting and stealing, 5.2s notices survive plays, private draft completion, responsive layouts, reduced motion and reconnect.');
} finally { await browser.close(); await game.close(); }
