import { bestSet, MANDATORY_TRADE_HAND_SIZE, SET_VALUES, TERRITORY_MATCH_BONUS } from '../../engine/rules';
import type { GameMap, GameState, PlayerState, TerritoryCard } from '../../types/game';
import { NEON } from '../theme';

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function stepToggleHtml(step: number): string {
  return `<div class="step-toggle">${[1, 5].map(n => `<button data-step="${n}" class="${step === n ? 'on' : ''}">×${n}</button>`).join('')}<button data-step="999" class="${step === 999 ? 'on' : ''}">ALL</button></div>`;
}

export function placementChipsHtml(placements: ReadonlyMap<number, number>, territoryName: (id: number) => string): string {
  return [...placements].filter(([, n]) => n > 0).map(([id, n]) => `<span>${escapeHtml(territoryName(id))}<b>+${n}</b></span>`).join('') || '<span class="empty">Tap your territories to place troops</span>';
}

export function deploymentPhaseHtml(left: number, step: number, chips: string): string {
  return `<div class="big"><span class="n">${left}</span><span class="t">STARTING TROOPS<small>Fortify your borders before turn 1</small></span>${stepToggleHtml(step)}</div>
    <div class="chips">${chips}</div>
    <div class="actions"><button class="btn ghost" id="undo">UNDO</button><button class="primary btn" id="deploy" ${left ? 'disabled' : ''}>DEPLOY ▸</button></div>`;
}

export function draftPhaseHtml(options: {
  left: number; step: number; parts: string; cards: TerritoryCard[]; traded: ReadonlySet<number>;
  required: boolean; chips: string; territoryName(id: number): string;
}): string {
  const { left, step, parts, cards, traded, required, chips, territoryName } = options;
  const set = bestSet(cards.filter(c => !traded.has(c.id)));
  const shape = { INFANTRY: '■', CAVALRY: '▲', ARTILLERY: '●', WILD: '◆' };
  const hand = cards.map(c => `<span class="card ${c.emblem} ${traded.has(c.id) ? 'traded' : ''}" title="${escapeHtml(c.territoryId === null ? 'Wild card (substitutes for any emblem)' : territoryName(c.territoryId))}">${shape[c.emblem]}</span>`).join('');
  return `<div class="big"><span class="n">${left}</span><span class="t">TROOPS TO PLACE<small>${escapeHtml(parts)}</small></span>${stepToggleHtml(step)}</div>
    <section class="cards-section" aria-label="Cards">
      <details class="cards-help">
        <summary><span>CARDS</span><span class="help-icon" aria-label="Help about cards and trading">?</span></summary>
        <div class="cards-help-content">
          <p>Conquer at least one territory to earn one card at the end of your turn (not one per capture).</p>
          <p>During Draft, trade exactly 3 cards as a set for extra troops to place:</p>
          <ul><li>3 Infantry (■): +${SET_VALUES.INFANTRY} troops</li><li>3 Cavalry (▲): +${SET_VALUES.CAVALRY} troops</li><li>3 Artillery (●): +${SET_VALUES.ARTILLERY} troops</li><li>One of each (■ ▲ ●): +${SET_VALUES.ONE_OF_EACH} troops</li></ul>
          <p>Wild cards (◆) substitute for any emblem. TRADE automatically chooses your highest-value set; NO SET means you do not have a valid set.</p>
          <p>With ${MANDATORY_TRADE_HAND_SIZE}+ cards, you must trade until fewer than ${MANDATORY_TRADE_HAND_SIZE} remain before attacking. You can trade additional sets during Draft.</p>
          <p>If a traded card names a territory you own, that territory automatically receives +${TERRITORY_MATCH_BONUS} troops. Only the first matching territory gets this bonus per set.</p>
          <p>Traded cards are discarded. UNDO cancels planned trades and troop placements before you enter Attack.</p>
        </div>
      </details>
      ${cards.length ? `<div class="hand">${hand}<button class="chip-btn" id="trade" ${set ? '' : 'disabled'}>${set ? `TRADE +${set.value}` : 'NO SET'}</button></div>` : '<div class="note">No cards yet.</div>'}
    </section>
    ${required ? '<div class="hint warn">5+ cards: you must trade a set before continuing.</div>' : ''}
    <div class="chips">${chips}</div>
    <div class="actions"><button class="btn ghost" id="undo">UNDO</button><button class="primary btn" id="start-atk" ${left !== 0 || required ? 'disabled' : ''}>ATTACK</button></div>`;
}

export function movementPhaseHtml(troops: number, min: number, max: number, route: string, results = ''): string {
  return `<div class="big"><span class="n">${troops}</span><span class="t">TROOPS TO MOVE<small>${escapeHtml(route)} (min ${min}, max ${max})</small></span></div>
    <div class="stop-palette"><button class="sp-btn" id="move-minus">−</button><input type="number" id="move-input" value="${troops}" min="${min}" max="${max}" class="atk-stop-input" aria-label="Troops to move"><button class="sp-btn" id="move-plus">+</button><button class="sp-btn" id="move-set">SET</button></div>
    <div class="actions"><button class="btn" id="move-min">MIN ${min}</button><button class="btn" id="move-max">MAX ${max}</button><button class="primary btn" id="move-confirm">MOVE ▸</button></div>${results}`;
}

export function attackConfirmationHtml(armies: number, max: number, route: string, stop: number | null): string {
  const maxStop = Math.max(1, armies - 1);
  return `<div class="big"><span class="n">${armies}</span><span class="t">ARMIES<small>${escapeHtml(route)} (max ${max})</small></span></div>
    <fieldset class="stop-palette" ${armies <= 1 ? 'disabled' : ''} aria-label="Attack stop limit">
      <button class="sp-btn" id="atk-stop-toggle" aria-pressed="${stop !== null}">STOP AT</button><button class="sp-btn" id="atk-stop-minus">−</button>
      <input type="number" id="atk-stop-input" value="${stop ?? maxStop}" min="1" max="${maxStop}" class="atk-stop-input" aria-label="Stop at attacking armies">
      <button class="sp-btn" id="atk-stop-plus">+</button><button class="sp-btn stop-off" id="atk-stop-off" ${stop === null ? 'disabled' : ''}>OFF</button>
    </fieldset><div class="note">${armies <= 1 ? 'Stop At unavailable with only 1 attacking army.' : 'Stop at remaining attacking armies (excludes 1 reserved army).'}</div>
    <div class="actions"><button class="btn" id="atk-cancel">CANCEL</button><button class="primary btn" id="atk-confirm">CONFIRM ATTACK</button></div>`;
}

export function fortifyPhaseHtml(options: { hint: string; move?: { from: string; to: string; troops: number }; interactive: boolean }): string {
  const { hint, move, interactive } = options;
  return `<div class="hint">${escapeHtml(hint)}</div>
    ${move ? `<div class="fort">${escapeHtml(move.from)}<em>⇢</em>${escapeHtml(move.to)}<div class="stepper"><button id="f-m">−</button><b>${move.troops}</b><button id="f-p">+</button><button id="f-max">MAX</button></div></div>` : '<div class="note">Optional fortify move. Skip if your lines are fine.</div>'}
    <div class="actions">${interactive ? '<button class="btn" id="fortify-back">BACK TO ATTACK</button>' : '<button class="btn ghost" data-go="attack">◂</button>'}${move ? '<button class="btn" id="f-clear">CLEAR</button>' : ''}${interactive ? '<button class="primary btn" id="fortify-finish">FINISH TURN</button>' : '<button class="primary btn" data-go="commit">REVIEW ▸</button>'}</div>`;
}

export function gameOverPhaseHtml(won: boolean, winnerName: string | null, round: number, commanders: number): string {
  return `<div class="big"><span class="n" style="color:${won ? 'var(--lime)' : 'var(--mag)'}">${won ? '★' : '✕'}</span><span class="t">${winnerName === null ? 'YOU WERE ELIMINATED' : won ? 'VICTORY' : `${escapeHtml(winnerName)} WINS`}<small>Turn ${round} · ${commanders} commanders</small></span></div>
    <div class="actions">${winnerName === null ? '<button class="btn" id="watch">FINISH ▸▸</button>' : '<button class="btn" id="stats">STATS</button>'}<button class="primary btn" id="menu">MENU</button></div>`;
}

export function phaseIds(html: string, prefix: string): string {
  return html.replace(/\bid="/g, `id="${prefix}`);
}

export function territoryPillHtml(territory: string, commander: string, continent: string, bonus: number, troops: number): string {
  return `<span class="sw"></span><div><b>${escapeHtml(territory)}</b><br><small>${escapeHtml(commander)} · ${escapeHtml(continent)} +${bonus}</small></div><span class="tr">${troops}</span>`;
}

export function commanderBadgesHtml(state: GameState, active: number, name: (p: PlayerState) => string = p => p.name): string {
  return state.players.map((p, i) => {
    const n = state.territories.filter(t => t.owner === i).length;
    return `<span class="${i === active ? 'active' : ''} ${p.eliminated && !n ? 'out' : ''}" style="--pc:${NEON.players[i]}" title="${escapeHtml(name(p))}">${n}</span>`;
  }).join('');
}

export function commanderRosterHtml(state: GameState, me: number, name: (p: PlayerState) => string = p => p.name): string {
  return state.players.map((p, i) => {
    const territories = state.territories.filter(t => t.owner === i), label = name(p);
    return `<li class="roster-row ${i === state.activePlayerIndex ? 'active' : ''} ${p.eliminated ? 'out' : ''}" style="--pc:${NEON.players[i]}"><span class="sw"></span><span class="nm">${escapeHtml(label)}${i === me && label !== 'YOU' ? ' (YOU)' : ''}</span><span class="st"><span>${territories.length}<em>TER</em></span><span>${territories.reduce((sum, t) => sum + t.troops, 0)}<em>TRP</em></span><span>${p.cards.length}<em>CRD</em></span></span></li>`;
  }).join('');
}

export function continentIntelHtml(map: GameMap, state: GameState, name: (p: PlayerState) => string = p => p.name): string {
  return map.continents.map(c => {
    const counts: number[] = state.players.map(() => 0);
    c.territoryIds.forEach(id => counts[state.territories[id].owner]++);
    const lead = counts.indexOf(Math.max(...counts));
    return `<li class="cont-row" style="--cc:${NEON.continents[c.id % NEON.continents.length]};--pc:${NEON.players[lead]}"><span class="sw"></span><span>${escapeHtml(c.name)}</span><span class="bn">+${c.bonus}</span><span class="bar"><span style="width:${counts[lead] * 100 / c.territoryIds.length}%"></span></span><span class="own">${counts[lead]}/${c.territoryIds.length} ${escapeHtml(name(state.players[lead]))}</span></li>`;
  }).join('');
}
