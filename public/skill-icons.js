// Skill silhouettes share the table's card-and-gold visual language.
const artwork = {
  peek: '<rect class="skill-icon-paper" x="9" y="5" width="25" height="36" rx="4"/><path d="M3 25q21-23 42 0-21 23-42 0Z" class="skill-icon-seal"/><circle cx="24" cy="25" r="6"/><path d="M24 4v4m-17 3 4 4m30-4-4 4"/>',
  upgrade: '<rect class="skill-icon-paper" x="6" y="11" width="25" height="33" rx="4"/><path d="M12 33h5v-6h6v-6h5M36 35V4m-7 8 7-8 7 8"/><path d="m14 15 2 3-2 3-2-3Z"/>',
  wild: '<rect class="skill-icon-paper" x="9" y="9" width="25" height="34" rx="4" transform="rotate(-9 21 26)"/><path d="m23 16 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z"/><path d="M38 3v10m-5-5h10"/>',
  gift: '<rect class="skill-icon-paper" x="5" y="12" width="21" height="29" rx="4"/><path d="m15 21 4 5-4 5-4-5Z"/><path d="M27 10h15m-5-5 5 5-5 5"/><circle cx="36" cy="27" r="4"/><path d="M29 41v-3a7 7 0 0 1 14 0v3"/>',
  steal: '<rect class="skill-icon-paper" x="23" y="8" width="20" height="29" rx="4"/><path d="m32 17 4 5-4 5-4-5Z"/><path d="M20 14H5m0-5-5 5 5 5"/><circle cx="11" cy="32" r="4"/><path d="M3 44v-3a8 8 0 0 1 16 0v3"/>',
  reroll: '<rect class="skill-icon-paper" x="15" y="12" width="19" height="27" rx="4"/><path d="m24 19 4 6-4 6-4-6Z"/><path d="M7 20A18 18 0 0 1 37 9m0-6v7h-7M41 29A18 18 0 0 1 11 40m0 6v-7h7"/>',
  remove: '<rect class="skill-icon-paper" x="8" y="7" width="25" height="34" rx="4"/><path d="M14 15h6l-4 4 4 3v3h-6"/><circle class="skill-icon-seal" cx="34" cy="34" r="10"/><path d="M29 34h10"/>',
  clone: '<rect class="skill-icon-paper" x="5" y="6" width="24" height="31" rx="4"/><rect class="skill-icon-paper" x="15" y="13" width="24" height="31" rx="4"/><path d="M27 23v12m-6-6h12"/>',
  draw: '<rect class="skill-icon-paper" x="2" y="19" width="15" height="23" rx="3" transform="rotate(-14 10 30)"/><rect class="skill-icon-paper" x="11" y="15" width="17" height="27" rx="3"/><rect class="skill-icon-paper" x="22" y="15" width="17" height="27" rx="3"/><rect class="skill-icon-paper" x="33" y="19" width="13" height="23" rx="3" transform="rotate(14 39 30)"/><path d="M24 3v8m-4-4 4 4 4-4M20 23h7l-4 4 4 2v6h-7"/>',
  draft: '<rect class="skill-icon-paper" x="1" y="18" width="12" height="22" rx="3"/><rect class="skill-icon-paper" x="11" y="13" width="14" height="27" rx="3"/><rect class="skill-icon-paper" x="23" y="11" width="14" height="29" rx="3"/><rect class="skill-icon-paper" x="35" y="18" width="12" height="22" rx="3"/><path d="m17 24 4 4 7-9M24 42v4"/>',
};

export function skillIcon(id) {
  return `<svg class="skill-icon" data-skill-icon="${Object.hasOwn(artwork, id) ? id : 'wild'}" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${artwork[id] || artwork.wild}</svg>`;
}

export const skillSummary = {
  wild: '随机一张牌变万能牌，含大小王', gift: '随机赠送两张手牌给指定玩家',
  steal: '从指定玩家手中随机拿走最多两张牌',
  reroll: '选两张手牌换成随机牌', remove: '删除最小的两张手牌',
  clone: '随机复制自己的两张手牌', draw: '获得四张随机牌',
  draft: '从四张随机牌中选一张加入手牌',
  peek: '查看指定玩家最多五张随机手牌', upgrade: '一张牌升一级或两级，最高大王',
};
