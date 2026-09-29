import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createGameServer } from '../server.js';
import { makeDeck, sortCards } from '../lib/game.js';
import { skillSummary } from '../public/skill-icons.js';
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
    const page = await context.newPage(); pages.push(page); page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    if (!i) {
      assert.equal(await page.locator('#lobby .entry-actions button').count(), 2);
      for (const width of [320, 375, 414, 768]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.ok(await page.locator('.entry-actions').evaluate(node => node.scrollWidth <= node.clientWidth));
      }
      await page.screenshot({ path: 'test-results/skills-lobby.png', fullPage: true });
      await page.setViewportSize({ width: 1366, height: 768 });
    }
    await page.locator('#nickname').fill(['阿青', '小满', '老周'][i]);
    if (!i) await createRoom(page, { skills: true });
    else await joinRoom(page, await pages[0].locator('#room-title').textContent());
    await page.locator('#game').waitFor({ state: 'visible' });
    assert.ok(await page.locator('body').evaluate(node => node.classList.contains('skills-mode')));
  }
  for (const page of pages) await page.locator('[data-action="ready"]').click();
  const room = game.rooms.get(await pages[0].locator('#room-title').textContent());
  assert.equal(room.mode, 'skills');
  const leaderIndex = room.turn, page = pages[leaderIndex];
  await page.locator('[data-action="bid-3"]:not([disabled])').click();
  await page.locator('[data-action="hint"]').waitFor();
  const other = pages.find(item => item !== page);
  await other.locator('#skill-button').click();
  assert.equal(await other.locator('[data-skill-use]').isDisabled(), true, 'off-turn skill is disabled');
  await other.locator('#skill-dialog [data-close]').click();

  for (const id of ['gift', 'reroll', 'clone', 'draw', 'draft', 'wild', 'peek', 'upgrade', 'remove']) {
    const p = room.players[leaderIndex];
    room.turn = leaderIndex; room.actionAt = 0; room.lastPlay = null; room.tablePlays = {}; room.tablePasses = {};
    p.hand = sortCards(makeDeck().slice(0, id === 'draw' ? 24 : id === 'remove' ? 1 : 20));
    if (id === 'upgrade') p.hand = sortCards(makeDeck().filter(card => card.rank >= 15));
    p.skill = { id, used: false, choices: null };
    await page.reload(); await page.locator('#skill-button:not([disabled])').waitFor();
    assert.equal(await page.locator('#skill-button [data-skill-icon]').getAttribute('data-skill-icon'), id);
    assert.equal(await page.locator('#skill-summary').textContent(), skillSummary[id]);
    await page.screenshot({ path: `test-results/skill-icon-${id}.png`, fullPage: true, animations: 'disabled' });
    const before = p.hand.length;
    await page.locator('#skill-button').click();
    assert.equal(await page.locator('#skill-title [data-skill-icon]').getAttribute('data-skill-icon'), id);
    await page.locator('#skill-dialog [data-close]').click();
    assert.equal(p.skill.used, false, 'viewing a skill does not consume it');
    await page.locator('#skill-button').click();
    if (id === 'upgrade') {
      assert.equal(await page.locator('#skill-card option').count(), 5, 'big joker is excluded');
      await page.locator('#skill-card').selectOption(String(p.hand.find(card => card.rank === 15).id));
      await page.locator('#skill-steps').selectOption('2');
      assert.equal(await page.locator('#skill-steps').inputValue(), '2');
    }
    await page.locator('[data-skill-use]:not([disabled])').click();
    await page.waitForFunction(() => document.querySelector('#skill-button').classList.contains('skill-spent') || document.querySelector('[data-skill-choice]'));
    assert.equal(p.skill.used, true);
    if (id === 'draft') {
      assert.equal(await page.locator('[data-skill-choice]').count(), 4);
      const chosen = p.skill.choices[1].id;
      await page.locator('#skill-dialog [data-close]').click();
      assert.equal(await page.locator('[data-action="play"]').isDisabled(), true);
      await page.reload(); await page.locator('#skill-button').click();
      assert.equal(await page.locator('[data-skill-choice]').count(), 4);
      await page.screenshot({ path: 'test-results/skill-draft.png', fullPage: true, animations: 'disabled' });
      await page.locator(`[data-skill-choice="${chosen}"]`).click();
      await page.locator('#skill-dialog').waitFor({ state: 'hidden' });
      assert.ok(p.hand.some(card => card.id === chosen)); assert.equal(p.hand.length, before + 1);
    } else if (id === 'peek') {
      assert.equal(await page.locator('.skill-inspection .playing-card').count(), 5);
      await page.screenshot({ path: 'test-results/skill-peek-private.png', animations: 'disabled' });
      await page.locator('#skill-dialog [data-close]').click();
      await page.reload(); await page.locator('#skill-button:not([disabled])').waitFor(); await page.locator('#skill-button').click();
      assert.equal(await page.locator('.skill-inspection .playing-card').count(), 5);
      await page.locator('#skill-dialog [data-close]').click();
      assert.equal(await other.locator('.skill-inspection').count(), 0);
    } else if (id === 'wild') {
      const wild = p.hand.find(card => card.wild);
      await page.locator(`[data-wild-id="${wild.id}"]`).selectOption('17');
      await page.locator('#skill-dialog [data-close]').click();
      assert.ok((await page.locator(`#hand [data-card="${wild.id}"]`).getAttribute('aria-label')).includes('大王'));
      await page.locator(`#hand [data-card="${wild.id}"]`).focus(); await page.keyboard.press('Space');
      await page.locator('[data-action="play"]:not([disabled])').click();
      await page.waitForFunction(() => document.querySelector('#my-play .wild-card'));
      assert.equal(room.lastPlay.cards[0].rank, 17);
    } else {
      await page.locator('#skill-dialog').waitFor({ state: 'hidden' });
      assert.equal(p.hand.length, before + ({ gift: -2, reroll: 0, clone: 2, draw: 4, remove: -1, upgrade: 0 }[id]));
      if (id === 'upgrade') {
        assert.equal(p.hand.filter(card => card.rank === 17).length, 2);
        assert.equal(await page.locator('#hand [aria-label="大王"]').count(), 2);
      }
    }
    if (id === 'draw') {
      assert.equal(await page.locator('#hand [data-card]').count(), 28);
      for (const viewport of [{ width: 320, height: 812 }, { width: 375, height: 667 }, { width: 414, height: 896 }, { width: 768, height: 900 }, { width: 1280, height: 800 }, { width: 1366, height: 768 }]) {
        await page.setViewportSize(viewport); await page.waitForTimeout(160);
        const dimensions = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
        assert.ok(dimensions.w <= viewport.width && dimensions.h <= viewport.height, `28 cards fit ${viewport.width}x${viewport.height}: ${JSON.stringify(dimensions)}`);
        const clipped = await page.locator('#hand [data-card]').evaluateAll(cards => cards.filter(card => {
          const parent = card.closest('#hand').getBoundingClientRect(), box = card.getBoundingClientRect();
          return box.bottom > parent.bottom || box.left < parent.left || box.right > parent.right;
        }).length);
        assert.equal(clipped, 0, 'all 28 cards fit the hand area');
        assert.ok(await page.locator('#skill-dock').evaluate(dock => {
          const box = dock.getBoundingClientRect(), hand = document.querySelector('#hand').getBoundingClientRect();
          const player = document.querySelector('#my-player').getBoundingClientRect();
          const button = document.querySelector('#skill-button').getBoundingClientRect();
          const description = document.querySelector('#skill-summary').getBoundingClientRect();
          return box.left < innerWidth / 3 && box.right <= player.left && box.top >= hand.bottom && description.bottom <= innerHeight && button.height >= 44;
        }), 'lower-left skill dock and description fit without overlapping the hand or avatar');
        if (viewport.width === 375) await page.screenshot({ path: 'test-results/skills-28-mobile.png', fullPage: true });
      }
      await page.setViewportSize({ width: 375, height: 667 });
    }
  }
  assert.equal(room.phase, 'finished');
  assert.equal(room.result.winnerId, room.players[leaderIndex].id);
  assert.deepEqual(errors, []);
  console.log('Skill UI passed: nine skills, private inspection and reconnect, upgrade to big joker, off-turn/used states, private draft, wildcard play, skill win and six responsive viewports.');
} finally { await browser.close(); await game.close(); }
