import { SKILLS, canUpgrade } from '/skills.js';
import { rankLabel, isSkillMode } from '/game.js';
import { skillIcon, skillSummary } from './skill-icons.js';
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = card => card.wild ? '万能牌' : `${card.suit}${rankLabel(card.rank)}`;

export function createSkillUI({ getState, send, cardHTML, getSelected, getWildRank, onWildChange, isBlocked, getError }) {
  const button = document.querySelector('#skill-button'), dialog = document.querySelector('#skill-dialog'), content = document.querySelector('#skill-content');
  let error = '', submitting = false;
  function render() {
    const state = getState(), me = state?.players.find(player => player.id === state.me), skill = me?.skill;
    document.querySelector('#skill-dock').hidden = !isSkillMode(state?.mode);
    button.hidden = !isSkillMode(state?.mode);
    button.disabled = !skill;
    button.setAttribute('aria-busy', String(submitting));
    button.classList.toggle('skill-error', Boolean(error));
    const status = !skill ? '待发放' : skill.pending ? '待选牌' : skill.used ? '已使用' : state.phase === 'playing' && state.turnId === state.me ? '可使用' : '待回合';
    button.innerHTML = `${skillIcon(skill?.id)}<span class="skill-button-name">${skill ? SKILLS[skill.id].name : '本局技能'}</span><span class="skill-button-status">${status}</span>`;
    button.dataset.ready = String(status === '可使用' || status === '待选牌');
    document.querySelector('#skill-summary').textContent = skill ? skillSummary[skill.id] : '开局随机获得一个技能';
    button.classList.toggle('skill-spent', Boolean(skill?.used && !skill.pending));
    button.setAttribute('aria-label', skill ? `${SKILLS[skill.id].name} · ${skill.used ? '已使用' : '本局可用一次'}` : '开局获得技能');
    if (!dialog.open) return;
    if (!skill || !isSkillMode(state.mode)) { dialog.close(); return; }
    const info = SKILLS[skill.id];
    document.querySelector('#skill-title').innerHTML = `${skillIcon(skill.id)}<span>${info.name}</span>`;
    const previousCard = content.querySelector('#skill-card')?.value;
    const previousCard2 = content.querySelector('#skill-card-2')?.value;
    const previousSteps = content.querySelector('#skill-steps')?.value;
    const previousTarget = content.querySelector('#skill-target')?.value;
    const ownTurn = state.phase === 'playing' && state.turnId === state.me;
    const eligible = skill.id === 'upgrade' ? me.hand.filter(canUpgrade) : me.hand;
    let html = `<p class="skill-description">${info.description}</p>`;
    if (skill.pending) {
      html += `<p class="skill-status">选择一张加入手牌</p><div class="skill-choices">${skill.choices.map(card => `<button type="button" class="skill-choice secondary" data-skill-choice="${card.id}" aria-label="选择${label(card)}"${!ownTurn || isBlocked() ? ' disabled' : ''}>${cardHTML(card)}</button>`).join('')}</div>`;
    } else if (!skill.used) {
      const cardOptions = [...eligible].sort((a, b) => a.rank - b.rank || a.id - b.id).map(card => `<option value="${card.id}">${label(card)}</option>`).join('');
      if (info.card || skill.id === 'reroll') html += `<label for="skill-card">${skill.id === 'reroll' ? '第一张手牌' : '选择手牌'}</label><select id="skill-card">${cardOptions}</select>`;
      if (skill.id === 'reroll' && me.hand.length > 1) html += `<label for="skill-card-2">第二张手牌</label><select id="skill-card-2">${cardOptions}</select>`;
      if (skill.id === 'upgrade') html += '<label for="skill-steps">提升点数</label><select id="skill-steps"><option value="1">升一级</option><option value="2">升两级</option></select>';
      if (skill.id === 'upgrade') html += `<p class="skill-status">${eligible.length ? '大王和万能牌不可升级' : '没有可升级的手牌'}</p>`;
      if (info.target) html += `<label for="skill-target">${skill.id === 'peek' ? '查看谁的手牌' : '交给谁'}</label><select id="skill-target">${state.players.filter(player => player.id !== me.id).map(player => `<option value="${player.id}">${escape(player.name)} · ${player.id === state.landlordId ? '地主' : '农民'}</option>`).join('')}</select>`;
      html += `<p class="skill-status">${ownTurn ? '每局一次 · 使用后继续出牌' : '轮到你出牌时可使用'}</p><button type="button" class="primary wide" data-skill-use${!ownTurn || isBlocked() || (info.card && !eligible.length) ? ' disabled' : ''}>${skill.id === 'draft' ? '抽取四张' : skill.id === 'peek' ? '查看手牌' : '使用技能'}</button>`;
    } else html += '<p class="skill-status">本局技能已使用</p>';
    if (skill.inspection) {
      html += `<p class="skill-inspection-title">${escape(skill.inspection.targetName)} · 仅你可见</p><div class="skill-inspection">${skill.inspection.cards.map(card => cardHTML(card)).join('')}</div><p class="skill-status">使用技能时的手牌快照，不随对方后续出牌更新。可再次点击技能查看。</p>`;
    }
    for (const card of me.hand.filter(card => card.wild)) {
      html += `<label for="wild-rank-${card.id}">万能牌当作</label><select class="wild-rank" id="wild-rank-${card.id}" data-wild-id="${card.id}">${Array.from({ length: 15 }, (_, i) => i + 3).map(rank => `<option value="${rank}"${rank === getWildRank(card.id) ? ' selected' : ''}>${rankLabel(rank)}</option>`).join('')}</select><p class="skill-status">出牌前可更改，包括大小王</p>`;
    }
    content.innerHTML = `${html}<p class="form-error" role="alert">${escape(error)}</p>`;
    const cardSelect = content.querySelector('#skill-card');
    if (cardSelect) {
      const chosen = previousCard || (getSelected().size === 1 ? String([...getSelected()][0]) : '');
      if ([...cardSelect.options].some(option => option.value === chosen)) cardSelect.value = chosen;
    }
    const secondCard = content.querySelector('#skill-card-2');
    if (secondCard) {
      const chosen = previousCard2 || [...getSelected()].map(String).find(id => id !== cardSelect.value);
      if ([...secondCard.options].some(option => option.value === chosen && option.value !== cardSelect.value)) secondCard.value = chosen;
      else secondCard.value = [...secondCard.options].find(option => option.value !== cardSelect.value)?.value || cardSelect.value;
      for (const option of secondCard.options) option.disabled = option.value === cardSelect.value;
    }
    const stepSelect = content.querySelector('#skill-steps');
    if (stepSelect) {
      if (previousSteps === '2') stepSelect.value = '2';
      stepSelect.querySelector('option[value="2"]').disabled = me.hand.find(card => card.id === Number(cardSelect.value))?.rank >= 16;
      if (stepSelect.selectedOptions[0]?.disabled) stepSelect.value = '1';
    }
    const targetSelect = content.querySelector('#skill-target');
    if (targetSelect && [...targetSelect.options].some(option => option.value === previousTarget)) targetSelect.value = previousTarget;
  }
  button.addEventListener('click', () => { error = ''; dialog.showModal(); render(); });
  content.addEventListener('change', event => {
    if (event.target.matches('[data-wild-id]')) onWildChange(Number(event.target.dataset.wildId), Number(event.target.value));
    if (event.target.matches('#skill-card, #skill-card-2')) render();
  });
  content.addEventListener('click', async event => {
    if (event.target.closest('[data-skill-use]')) {
      if (submitting) return;
      error = '';
      submitting = true;
      const data = { cardId: Number(content.querySelector('#skill-card')?.value), cardIds: [...content.querySelectorAll('#skill-card, #skill-card-2')].map(select => Number(select.value)), steps: Number(content.querySelector('#skill-steps')?.value) || undefined, targetId: content.querySelector('#skill-target')?.value };
      if (await send('skill', data)) {
        const state = getState(), me = state?.players.find(player => player.id === state.me);
        if (!me?.skill.pending && !me?.skill.inspection && !me?.hand.some(card => card.wild)) dialog.close();
      } else error = getError() || '操作未完成，请重试。';
      submitting = false;
      render();
    }
    const choice = event.target.closest('[data-skill-choice]');
    if (choice) {
      if (submitting) return;
      error = '';
      submitting = true;
      if (await send('skill-choice', { cardId: Number(choice.dataset.skillChoice) })) dialog.close();
      else error = getError() || '选牌未完成，请重试。';
      submitting = false;
      render();
    }
  });
  return { render };
}
