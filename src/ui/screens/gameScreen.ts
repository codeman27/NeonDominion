import '../styles/game.css';
import { connectedOwned } from '../../engine/fortify';
import { bestSet, mustTrade } from '../../engine/rules';
import { computeReinforcements, validateTurnPlan } from '../../engine/turnEngine';
import type { TurnOutcome } from '../../transport/transport';
import { replayEventLog, type LocalGame } from '../../transport/localTransport';
import type { AttackCampaignOrder, CardTradeOrder, FortifyOrder, OccupyMode, TurnActionPlan, TurnResolutionResult, InteractiveTurnState, InteractiveAttackResult } from '../../types/actions';
import type { GameState, TerritoryCard, TerritoryId } from '../../types/game';
import { buildReplay, type ReplayFrame } from '../components/battleReplay';
import { battleResultsHtml } from '../components/battleResults';
import { openEventInspector, showVictory } from '../components/eventInspector';
import { renderMap, territoryPoint, type MapArrow } from '../components/hexMapRenderer';
import { MapCamera } from '../components/mapCamera';
import { NEON } from '../theme';
import { roundOfTurn } from '../rounds';
import { attackConfirmationHtml, commanderBadgesHtml, commanderRosterHtml, continentIntelHtml, deploymentPhaseHtml, draftPhaseHtml, fortifyPhaseHtml, gameOverPhaseHtml, movementPhaseHtml, placementChipsHtml, territoryPillHtml } from '../components/gamePhaseUi';

type Phase = 'setup' | 'draft' | 'attack' | 'move' | 'fortify' | 'commit' | 'waiting' | 'replay' | 'over' | 'interactive_attack';
/** Base duration of one replay beat at 1× speed. */
const BEAT_MS = 650;
const PLAN_PHASES = ['draft', 'attack', 'fortify', 'commit'] as const;
const STOPS = [1, 2, 3, 5];
const OCCUPY: { mode: OccupyMode; label: string }[] = [
  { mode: { type: 'ALL_BUT_ONE' }, label: 'ALL−1' }, { mode: { type: 'HALF' }, label: 'HALF' }, { mode: { type: 'MIN' }, label: 'MIN' },
];

export interface GameScreenOptions {
  onExit(): void;
  /** Called after every state change worth persisting. */
  onChange?(game: LocalGame): void;
}

interface PlannedAttack extends AttackCampaignOrder { chain: boolean }

/** The resolver counts all source troops, including the one that cannot attack. */
export function attackStopThreshold(remainingAttackers: number | null): number {
  return remainingAttackers == null ? 0 : remainingAttackers + 1;
}

/** Cards that pending trades refer to; the pre-trade snapshot is only valid during the interactive turn it was taken for. */
export function tradeHand(interactive: boolean, snapshot: TerritoryCard[] | null, liveHand: TerritoryCard[]): TerritoryCard[] {
  return interactive && snapshot ? snapshot : liveHand;
}

/** Game board + phase sheet (steps 1.15–1.16). Returns an unmount function. */
export function mountGameScreen(root: HTMLElement, game: LocalGame, opts: GameScreenOptions): () => void {
  root.innerHTML = GAME_HTML;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const svg = q('#map') as unknown as SVGSVGElement;
  const board = q('#board');
  const { map } = game;
  const me = game.localPlayerIndex;
  const S = (): GameState => game.getState();
  const tn = (id: TerritoryId) => map.territories[id].name;
  const color = (p: number) => NEON.players[p % NEON.players.length];
  const roundOf = (turnNumber: number, playerIndex: number) => roundOfTurn(game.getEvents(), turnNumber, playerIndex);

  const ui = {
    phase: 'setup' as Phase,
    step: 1,
    sel: null as TerritoryId | null,
    setup: new Map<TerritoryId, number>(),
    trades: [] as CardTradeOrder[],
    draft: new Map<TerritoryId, number>(),
    attacks: [] as PlannedAttack[],
    fortify: null as FortifyOrder | null,
    log: [] as string[],
    alive: true,
    frame: null as ReplayFrame | null,
    replayWho: 0,
    replayTurn: 0,
    speed: Number(localStorage.getItem('nd.speed')) === 2 ? 2 : 1,
    autoSkipBots: localStorage.getItem('nd.autoSkipBots') === '1',
    skip: false,
    sealing: false,
    wake: null as (() => void) | null,
    /** Interactive attack state: tracks the live GameState during the turn. */
    interactive: null as { state: InteractiveTurnState; lastResult: InteractiveAttackResult | null } | null,
    /** Move step state during interactive attack. */
    move: null as { from: TerritoryId; to: TerritoryId; troops: number; minMove: number; maxMove: number } | null,
    /** Pending attack being configured during commit phase. */
    pendingAttack: null as { from: TerritoryId; to: TerritoryId; troops: number } | null,
    /** Stop at this many remaining attacking armies, excluding the reserved army (null = no limit). */
    stopAtTroops: null as number | null,
    /** Snapshot of player's hand at commit time (before trades remove cards). */
    handSnapshot: null as TerritoryCard[] | null,
    /** Whether the post-attack BATTLE RESULTS breakdown is expanded (collapsed by default). */
    battleResultsOpen: false,
  };

  const camera = new MapCamera(board, svg, onTap, z => svg.classList.toggle('zoomed', z > 1.5));
  // Battle log: rebuilt from the text event log (so it survives resume), then kept live.
  replayEventLog(game.exportEventLog(), r => { ui.log.unshift(...describe(r)); });
  ui.log.length = Math.min(ui.log.length, 60);
  const offTurn = game.onTurnResolved(o => { ui.log.unshift(...describe(o.resolution)); ui.log.length = Math.min(ui.log.length, 60); });

  /* ------------------------------ derived values ------------------------------ */
  const owns = (id: TerritoryId) => {
    if (ui.interactive) return ui.interactive.state.liveState.territories[id].owner === me;
    return S().territories[id].owner === me;
  };
  const sum = (m: Map<TerritoryId, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const hand = (): TerritoryCard[] => S().players[me].cards;
  const tradedIds = () => new Set(ui.trades.flatMap(t => t.cardIds));
  const tradeCards = () => {
    const cards = tradeHand(ui.interactive !== null, ui.handSnapshot, hand());
    return ui.trades.map(t => t.cardIds.map(id => cards.find(c => c.id === id)!));
  };
  const reinf = () => computeReinforcements(map, S(), me, tradeCards());
  const setupLeft = () => S().players[me].setupTroops - sum(ui.setup);
  const draftLeft = () => reinf().total - sum(ui.draft);
  const tradeRequired = () => mustTrade(hand().length) && hand().length - tradedIds().size >= 5;
  const pendingCaptures = () => new Set(ui.attacks.map(a => a.toTerritoryId));

  function projectedTroops(): number[] {
    const t = S().territories.map(x => x.troops);
    const add = (m: Map<TerritoryId, number>) => m.forEach((n, id) => { t[id] += n; });
    if (ui.phase === 'setup') add(ui.setup);
    else if (PLAN_PHASES.includes(ui.phase as typeof PLAN_PHASES[number])) {
      add(ui.draft);
      for (const id of reinf().matchTerritories) t[id] += 2;
    }
    return t;
  }

  /** Get troop count for a territory, considering the live interactive state. */
  function getScaledTroops(id: TerritoryId): number {
    if (ui.interactive) {
      return ui.interactive.state.liveState.territories[id].troops;
    }
    return projectedTroops()[id];
  }

  function validTargets(): Set<TerritoryId> | null {
    if (ui.sel === null) return null;
    if ((ui.phase === 'attack' || ui.phase === 'commit' || ui.phase === 'interactive_attack') && ui.interactive) {
      // In interactive attack mode: highlight only enemy territories (attackable)
      const selId = ui.sel;
      const neighbors = map.territories[selId].neighbors;
      const targets = new Set<TerritoryId>();
      for (const n of neighbors) {
        const liveTerr = ui.interactive.state.liveState.territories[n];
        const liveOwner = liveTerr?.owner;
        const isOwned = liveOwner === me;
        if (!isOwned) targets.add(n);
      }
      // Debug: log territory states for troubleshooting
      const info = neighbors.map(n => {
        const t = map.territories[n];
        const lt = ui.interactive!.state.liveState.territories[n];
        return `${t.name}(id=${n},liveOwner=${lt?.owner},me=${me},enemy=${lt?.owner !== me})`;
      }).join(' | ');
      console.log(`[validTargets] sel=${selId}(${map.territories[selId].name},owner=${S().territories[selId].owner}) phase=${ui.phase} interactive=${!!ui.interactive} neighbors=[${info}] targets=[${[...targets].map(id => map.territories[id].name).join(',')}]`);
      return targets;
    }
    if (ui.phase === 'attack') {
      const taken = pendingCaptures();
      return new Set(map.territories[ui.sel].neighbors.filter(n => !owns(n) && !taken.has(n)));
    }
    if (ui.phase === 'fortify') {
      const live = ui.interactive ? ui.interactive.state.liveState : S();
      return connectedOwned(map, live, me, ui.sel);
    }
    return null;
  }

  function buildPlan(): TurnActionPlan {
    return {
      type: 'TURN_ACTION_PLAN', turnNumber: S().turnNumber, playerIndex: me, cardTrades: ui.trades,
      draftPlacements: [...ui.draft].map(([territoryId, troops]) => ({ territoryId, troops })),
      attackQueue: ui.attacks.map(({ chain: _c, ...o }) => o),
      fortify: ui.fortify,
    };
  }

  /* ------------------------------ rendering ------------------------------ */
  function draw(refit = false): void {
    const f = ui.frame;
    let arrows: MapArrow[] = [];
    if (ui.phase === 'attack') {
      arrows = ui.attacks.map((a, i) => ({ from: a.fromTerritoryId, to: a.toTerritoryId, kind: 'attack', label: String(i + 1) }));
    } else if (ui.phase === 'commit' && ui.interactive) {
      // Show pending attack during commit phase
      if (ui.pendingAttack) {
        arrows.push({ from: ui.pendingAttack.from, to: ui.pendingAttack.to, kind: 'attack', label: '!' });
      }
    } else if (ui.phase === 'move' && ui.move) {
      arrows.push({ from: ui.move.from, to: ui.move.to, kind: 'attack', label: 'M' });
    } else if (ui.pendingAttack) {
      arrows.push({ from: ui.pendingAttack.from, to: ui.pendingAttack.to, kind: 'attack', label: '!' });
    } else if (ui.fortify) {
      arrows.push({ from: ui.fortify.fromTerritoryId, to: ui.fortify.toTerritoryId, kind: 'fortify', label: 'F' });
    }
    let boosted = new Set([...(ui.phase === 'setup' ? ui.setup.keys() : ui.draft.keys())]);
    if (f) { arrows = f.arrow ? [f.arrow] : []; boosted = new Set(f.boosted ?? []); }
    // During interactive attack, show user's attackable territories (≥2 troops) as subtle highlights
    let myTerritories: Set<TerritoryId> | null = null;
    if (ui.phase === 'interactive_attack' && ui.interactive && ui.sel === null) {
      myTerritories = new Set();
      const liveTerrs = ui.interactive.state.liveState.territories;
      for (let i = 0; i < liveTerrs.length; i++) {
        const t = liveTerrs[i];
        if (t.owner === me && t.troops >= 2) myTerritories.add(i);
      }
    }
    const box = renderMap(svg, map, {
      colorMode: 'owner',
      owners: f ? f.owners : (ui.interactive ? ui.interactive.state.liveState.territories.map(t => t.owner) : S().territories.map(t => t.owner)),
      troops: f ? f.troops : (ui.interactive ? ui.interactive.state.liveState.territories.map(t => t.troops) : projectedTroops()),
      rotate: true,
      selected: f ? null : ui.sel, highlight: f ? null : validTargets(), boosted, arrows,
      debugSel: ui.sel, myTerritories,
    });
    camera.setFitBox(box, refit);

    // Debug overlay for valid targets
    const dbg = q('#debug-overlay');
    if (ui.sel && (ui.phase === 'interactive_attack' || ui.phase === 'attack')) {
      const neighbors = map.territories[ui.sel].neighbors;
      const targets = validTargets();
      dbg.hidden = false;
      dbg.textContent = `SEL: ${map.territories[ui.sel].name}(${ui.sel})\nNEIGHBORS: ${neighbors.map(n => `${map.territories[n].name}(${n})`).join(', ')}\nTARGETS: ${targets ? [...targets].map(t => map.territories[t].name).join(', ') : 'none'}\nPHASE: ${ui.phase}\nme: ${me}`;
    } else {
      dbg.hidden = true;
    }

    renderTop();
    renderSheet();
    renderDrawer();
  }

  function renderTop(): void {
    const s = S();
    const replaying = ui.phase === 'replay' && ui.frame;
    const turn = replaying ? roundOf(ui.replayTurn, ui.replayWho) : s.turnNumber ? roundOf(s.turnNumber, s.activePlayerIndex) : 0;
    const active = replaying ? ui.replayWho : s.phase === 'ACTIVE_TURN_COMMIT' ? s.activePlayerIndex : -1;
    const owners = ui.frame ? ui.frame.owners : s.territories.map(t => t.owner);
    q('#turn').textContent = turn ? String(turn).padStart(2, '0') : '—';
    q('#players').innerHTML = commanderBadgesHtml({ ...s, territories: s.territories.map((t, i) => ({ ...t, owner: owners[i] })) }, active);
    const phases = q('#phases');
    const isInteractive = ui.phase === 'interactive_attack' || ui.phase === 'move' || ui.phase === 'attack' || (ui.phase === 'commit' && ui.interactive);
    phases.hidden = !PLAN_PHASES.includes(ui.phase as typeof PLAN_PHASES[number]) && !isInteractive;
    const idx = PLAN_PHASES.indexOf(ui.phase as typeof PLAN_PHASES[number]);
    if (isInteractive) {
      // Hide phase bar during interactive mode — all controls are in the sheet
      phases.hidden = true;
    } else {
      const idx2 = PLAN_PHASES.indexOf(ui.phase as typeof PLAN_PHASES[number]);
      phases.querySelectorAll('button').forEach((b, i) => { b.classList.toggle('active', i === idx2); b.classList.toggle('done', i < idx2); });
    }
    q('#badge-draft').textContent = idx >= 0 && draftLeft() ? String(draftLeft()) : '';
    q('#badge-attack').textContent = ui.attacks.length ? String(ui.attacks.length) : '';
  }

  function renderSheet(): void {
    const sheet = q('#sheet');
    const s = S();
    const back = (p: Phase) => `<button class="btn ghost" data-go="${p}">◂</button>`;

    if (ui.phase === 'setup') {
      sheet.innerHTML = deploymentPhaseHtml(setupLeft(), ui.step, placementChipsHtml(ui.setup, tn));
      q('#undo').onclick = () => { ui.setup.clear(); draw(); };
      q('#deploy').onclick = deploy;
    } else if (ui.phase === 'draft') {
      const r = reinf();
      const traded = tradedIds();
      const remaining = hand().filter(c => !traded.has(c.id));
      const set = bestSet(remaining);
      const parts = [`${r.base} base`, r.continentBonus ? `${r.continentBonus} continents` : '', r.cardTradeBonus ? `${r.cardTradeBonus} cards` : ''].filter(Boolean).join(' + ');
      sheet.innerHTML = draftPhaseHtml({
        left: draftLeft(), step: ui.step, parts: parts + (r.matchTerritories.length ? ` · +2 on ${r.matchTerritories.map(tn).join(', ')}` : ''),
        cards: hand(), traded, required: tradeRequired(), chips: placementChipsHtml(ui.draft, tn), territoryName: tn,
      });
      q('#undo').onclick = () => { ui.draft.clear(); ui.trades = []; draw(); };
      q('#start-atk').onclick = commitTurn;
      if (set) q('#trade').onclick = () => { ui.trades.push({ cardIds: set.cardIds }); draw(); toast(`Traded a set for +${set.value} troops`); };
    } else if (ui.phase === 'attack') {
      // In interactive mode, render the interactive attack sheet
      if (ui.interactive) {
        const interactive = ui.interactive;
        const hasMore = interactive.lastResult?.moreAttacks;
        const hasAttacks = interactive.state.remainingAttacks.length > 0;
        const diceHtml = interactive.lastResult
          ? (() => {
              const w = interactive.lastResult.attack.waves;
              if (!w?.length) return '';
              const lastWave = w[w.length - 1];
              const pairs = Math.min(lastWave.attackerDice.length, lastWave.defenderDice.length);
              const attDice = lastWave.attackerDice.map((v, i) => `<span class="die a ${i < pairs && v > lastWave.defenderDice[i] ? 'won' : ''}">${v}</span>`).join('');
              const defDice = lastWave.defenderDice.map((v, i) => `<span class="die d ${i < pairs && v >= lastWave.attackerDice[i] ? 'won' : ''}">${v}</span>`).join('');
              return `<div class="rp-dice"><div>${attDice}</div><span class="vs">vs</span><div>${defDice}</div></div>`;
            })()
          : '';
        const attackDesc = interactive.lastResult
          ? (() => {
              const a = interactive.lastResult.attack;
              const conquered = a.conquered ? ' ★ conquered!' : '';
              return `${tn(a.fromTerritoryId)} → ${tn(a.toTerritoryId)}${conquered}`;
            })()
          : '';
        if (ui.pendingAttack) {
          const { from, to } = ui.pendingAttack;
          const sourceTroops = getScaledTroops(from);
          const maxTroops = Math.max(0, sourceTroops - 1);
          const troops = ui.move?.troops ?? sourceTroops;
          const actualTroops = Math.min(troops, maxTroops);
          sheet.innerHTML = `
            <div class="big"><span class="n">${actualTroops}</span><span class="t">ARMIES<small>${tn(from)} → ${tn(to)} (max ${maxTroops})</small></span><div class="step-toggle">${[1, 5].map(n => `<button data-step="${n}" class="${ui.step === n ? 'on' : ''}">×${n}</button>`).join('')}<button data-step="999" class="${ui.step === 999 ? 'on' : ''}">ALL</button></div></div>
            <div class="actions"><button class="btn" id="atk-cancel">CANCEL</button><button class="primary btn" id="atk-confirm">CONFIRM ATTACK</button></div>`;
          q('#atk-cancel').onclick = () => { ui.pendingAttack = null; ui.sel = null; draw(); };
          q('#atk-confirm').onclick = async () => { await onConfirmAttack(); };
        } else {
          // Show last attack result at the top of the attack sheet
          let resultHtml = '';
          if (interactive.lastResult) {
            const a = interactive.lastResult.attack;
            const w = a.waves?.[a.waves.length - 1];
            const pairs = w ? Math.min(w.attackerDice.length, w.defenderDice.length) : 0;
            const attDice = (w?.attackerDice || []).map((v, i) => `<span class="die a ${i < pairs && v > w.defenderDice[i] ? 'won' : ''}">${v}</span>`).join('');
            const defDice = (w?.defenderDice || []).map((v, i) => `<span class="die d ${i < pairs && v >= w.attackerDice[i] ? 'won' : ''}">${v}</span>`).join('');
            const conquered = a.conquered ? ' ★ conquered!' : '';
            const diceRow = w ? `<div class="rp-dice"><div>${attDice}</div><span class="vs">vs</span><div>${defDice}</div></div>` : '';
            resultHtml = `<div class="last-result"><div class="result-line">${tn(a.fromTerritoryId)} → ${tn(a.toTerritoryId)} <b>${conquered}</b></div>${diceRow}</div>`;
          }
          sheet.innerHTML = `
            ${resultHtml}
            <div class="summary"><div><b>${interactive.state.remainingAttacks.length}</b><small>REMAINING</small></div></div>
            <div class="rp-cap ${interactive.lastResult?.attack.conquered ? 'won' : 'neutral'}">${attackDesc || 'Select a target to attack'}</div>${diceHtml}
            <div class="actions">${hasMore ? '<button class="primary btn" id="atk-next">ATTACK ▸</button>' : ''}${hasMore || hasAttacks ? back('attack') : ''}<button class="btn" id="fortify-now">FORTIFY ▸▸</button></div>`;
          const atkBtn = q('#atk-next');
          if (atkBtn) atkBtn.onclick = onAttackNext;
          const fortBtn = q('#fortify-now');
          if (fortBtn) fortBtn.onclick = onFortifyNow;
        }
        return;
      }
      const rows = ui.attacks.map((a, i) => `
        <div class="atk-item ${a.chain ? 'chain' : ''}"><span class="no">${i + 1}</span>
          <span class="p">${a.chain ? '↳ ' : ''}${tn(a.fromTerritoryId)}<em>→</em>${tn(a.toTerritoryId)}</span>
          <button class="o" data-stop="${i}" title="Stop when attackers drop to">STOP≤${a.stopWhenAttackerAtOrBelow}</button>
          <button class="o" data-occ="${i}" title="Troops to move in">${OCCUPY.find(o => o.mode.type === a.occupyMode.type)!.label}</button>
          <button class="x" data-rm="${i}" aria-label="Remove">×</button></div>`).join('');
      sheet.innerHTML = `
        <div class="hint">${ui.sel === null ? 'Tap <b>your territory</b>, then a <b>pulsing enemy</b>. Captured targets can attack again (chain).' : `From <b>${tn(ui.sel)}</b>: tap a pulsing target`}</div>
        <div class="atk-list">${rows || '<div class="note">No attacks queued. Dice are rolled only after you commit.</div>'}</div>
        <div class="actions"><button class="primary btn" id="start-interactive">ATTACK</button></div>`;
      q('#start-interactive').onclick = commitTurn;
      sheet.querySelectorAll<HTMLElement>('[data-stop]').forEach(b => b.onclick = () => {
        const a = ui.attacks[Number(b.dataset.stop)];
        a.stopWhenAttackerAtOrBelow = STOPS[(STOPS.indexOf(a.stopWhenAttackerAtOrBelow) + 1) % STOPS.length];
        renderSheet();
      });
      sheet.querySelectorAll<HTMLElement>('[data-occ]').forEach(b => b.onclick = () => {
        const a = ui.attacks[Number(b.dataset.occ)];
        a.occupyMode = OCCUPY[(OCCUPY.findIndex(o => o.mode.type === a.occupyMode.type) + 1) % OCCUPY.length].mode;
        renderSheet();
      });
      sheet.querySelectorAll<HTMLElement>('[data-rm]').forEach(b => b.onclick = () => { removeAttack(Number(b.dataset.rm)); draw(); });
    } else if (ui.phase === 'fortify') {
      const f = ui.fortify;
      const inInteractive = !!ui.interactive;
      const max = f ? (inInteractive ? getScaledTroops(f.fromTerritoryId) : projectedTroops()[f.fromTerritoryId]) - 1 : 0;
      sheet.innerHTML = fortifyPhaseHtml({
        hint: ui.sel === null ? `Optional: tap a source, then any connected territory of yours.${inInteractive ? ' Then END TURN.' : ''}` : `From ${tn(ui.sel)}: tap a pulsing destination`,
        move: f ? { from: tn(f.fromTerritoryId), to: tn(f.toTerritoryId), troops: f.troops } : undefined,
        interactive: inInteractive,
      });
      if (f) {
        q('#f-m').onclick = () => { f.troops = Math.max(1, f.troops - 1); renderSheet(); };
        q('#f-p').onclick = () => { f.troops = Math.min(max, f.troops + 1); renderSheet(); };
        q('#f-max').onclick = () => { f.troops = max; renderSheet(); };
        q('#f-clear').onclick = () => { ui.fortify = null; draw(); };
      }
      const backBtn = q('#fortify-back');
      if (backBtn) backBtn.onclick = () => { ui.phase = 'commit'; ui.sel = null; draw(); };
      if (inInteractive) {
        q('#fortify-finish').onclick = () => { onCompleteAttack(); };
      }
    } else if (ui.phase === 'commit' && !ui.interactive) {
      const errors = validateTurnPlan(map, s, buildPlan());
      sheet.innerHTML = `
        <div class="summary"><div><b>${sum(ui.draft)}</b><small>PLACED</small></div><div><b>${ui.attacks.length}</b><small>ATTACKS</small></div><div><b>${ui.fortify ? 1 : 0}</b><small>FORTIFY</small></div></div>
        <div class="note">${errors.length ? `<span style="color:var(--sun)">${errors[0]}</span>` : 'Your whole turn gets signed and locked. Dice stay sealed until the next commander reveals their seed.'}</div>
        <div class="actions">${back('fortify')}<button class="primary btn" id="commit" ${errors.length ? 'disabled' : ''}>COMMIT TURN</button></div>`;
      q('#commit').onclick = commitTurn;
    } else if (ui.phase === 'commit' || ui.phase === 'interactive_attack') {
      const interactive = ui.interactive;
      const hasMore = interactive ? interactive.lastResult?.moreAttacks : false;

      // Pending attack: show troop slider and CONFIRM
      if (ui.pendingAttack) {
        const { from, to } = ui.pendingAttack;
        const sourceTroops = getScaledTroops(from);
        const maxTroops = Math.max(0, sourceTroops - 1);
        const troops = ui.move?.troops ?? sourceTroops;
        const actualTroops = Math.min(troops, maxTroops);
        sheet.innerHTML = `
          <div class="big"><span class="n">${actualTroops}</span><span class="t">ARMIES<small>${tn(from)} → ${tn(to)} (max ${maxTroops})</small></span><div class="step-toggle">${[1, 5].map(n => `<button data-step="${n}" class="${ui.step === n ? 'on' : ''}">×${n}</button>`).join('')}<button data-step="999" class="${ui.step === 999 ? 'on' : ''}">ALL</button></div></div>
          <div class="actions"><button class="btn" id="atk-cancel">CANCEL</button><button class="primary btn" id="atk-confirm">CONFIRM ATTACK</button></div>`;
        q('#atk-cancel').onclick = () => { ui.pendingAttack = null; ui.sel = null; draw(); };
        q('#atk-confirm').onclick = async () => { await onConfirmAttack(); };
      } else {
        // Attack result or selection state
        const promptText = ui.sel ? (ui.pendingAttack ? 'Set troop count below' : 'Tap adjacent enemy to attack') : 'TAP YOUR TERRITORY';
        const isInitialAttack = interactive && !interactive.lastResult;

        // Build attack history log from previous results
        let historyHtml = '';
        if (interactive && interactive.lastResult && interactive.lastResult.attack.conquered) {
          const a = interactive.lastResult.attack;
          const w = a.waves?.[a.waves.length - 1];
          const pairs = w ? Math.min(w.attackerDice.length, w.defenderDice.length) : 0;
          const attDice = (w?.attackerDice || []).map((v, i) => `<span class="die a ${i < pairs && v > w.defenderDice[i] ? 'won' : ''}">${v}</span>`).join('');
          const defDice = (w?.defenderDice || []).map((v, i) => `<span class="die d ${i < pairs && v >= w.attackerDice[i] ? 'won' : ''}">${v}</span>`).join('');
          const diceRow = w ? `<div class="rp-dice small"><div>${attDice}</div><span class="vs">vs</span><div>${defDice}</div></div>` : '';
          historyHtml = `<div class="atk-history">${diceRow}<div class="atk-result">${tn(a.fromTerritoryId)} → ${tn(a.toTerritoryId)} <b>★ conquered!</b></div></div>`;
        }

        sheet.innerHTML = `
          <div class="summary"><div><b>${interactive ? (interactive.lastResult ? interactive.state.remainingAttacks.length : ui.attacks.length) : 0}</b><small>REMAINING</small></div></div>
          <div class="rp-cap">${promptText}</div>
          <div class="actions">${isInitialAttack ? '<div class="hint-text">Tap your territory, then tap an adjacent enemy to attack</div>' : ''}${hasMore ? '<button class="primary btn" id="atk-next">ATTACK ▸</button>' : ''}${!isInitialAttack ? '<button class="btn" id="atk-continue">ATTACK ▸</button>' : ''}${!isInitialAttack ? '<button class="btn" id="fortify-now">FORTIFY ▸▸</button>' : ''}</div>
          ${historyHtml ? `<div class="atk-log"><small>LAST RESULT</small>${historyHtml}</div>` : ''}
          ${interactive?.lastResult ? battleResultsHtml(interactive.lastResult.attack, tn, ui.battleResultsOpen) : ''}`;
        const atkBtn = q('#atk-next');
        if (atkBtn) atkBtn.onclick = onAttackNext;
        const fortBtn = q('#fortify-now');
        if (fortBtn) fortBtn.onclick = onFortifyNow;
        const contBtn = q('#atk-continue');
        if (contBtn) contBtn.onclick = () => { ui.sel = null; ui.pendingAttack = null; draw(); };
      }
    } else if (ui.phase === 'replay' && ui.frame) {
      const f = ui.frame;
      const dice = f.dice ? (() => {
        const pairs = Math.min(f.dice.attacker.length, f.dice.defender.length);
        const die = (v: number, i: number, side: 'a' | 'd') => {
          const won = i < pairs && (side === 'a' ? v > f.dice!.defender[i] : v >= f.dice!.attacker[i]);
          return `<span class="die ${side} ${i < pairs ? (won ? 'won' : 'lost') : ''}">${v}</span>`;
        };
        return `<div class="rp-dice"><div>${f.dice.attacker.map((v, i) => die(v, i, 'a')).join('')}</div><span class="vs">vs</span><div>${f.dice.defender.map((v, i) => die(v, i, 'd')).join('')}</div></div>`;
      })() : '';
      const body = `<div class="rp-cap ${f.tone ?? ''}">${f.caption}</div>${dice}<div class="rp-sub">${f.sub ?? ''}</div>`;
      // Keep the header (and its buttons) stable across frames: replacing a button between
      // pointerdown and pointerup swallows the click, which made 1×/2×/SKIP feel unresponsive.
      const key = `${ui.replayWho}:${ui.replayTurn}`;
      const head = sheet.querySelector<HTMLElement>('.rp-head');
      if (head?.dataset.key === key) {
        q('.rp-body').innerHTML = body;
      } else {
        sheet.innerHTML = `
          <div class="rp-head" data-key="${key}" style="--pc:${color(ui.replayWho)}"><span class="sw"></span><b>${s.players[ui.replayWho].name}</b><small>TURN ${roundOf(ui.replayTurn, ui.replayWho)}</small>
            <div class="rp-ctl">${[1, 2].map(n => `<button data-speed="${n}">${n}×</button>`).join('')}<button id="rp-skip">SKIP ▸▸</button></div></div>
          <div class="rp-body">${body}</div>`;
        q('#rp-skip').onclick = () => { ui.skip = true; ui.wake?.(); };
        sheet.querySelectorAll<HTMLElement>('[data-speed]').forEach(b => b.onclick = () => {
          ui.speed = Number(b.dataset.speed); localStorage.setItem('nd.speed', String(ui.speed)); renderSheet();
        });
      }
      sheet.querySelectorAll<HTMLElement>('[data-speed]').forEach(b => b.classList.toggle('on', Number(b.dataset.speed) === ui.speed));
    } else if (ui.phase === 'move' && ui.pendingAttack) {
      // Attack troop count selection
      const p = ui.pendingAttack;
      const sourceTroops = getScaledTroops(p.from);
      const maxTroops = Math.max(0, sourceTroops - 1);
      const troops = ui.move?.troops ?? sourceTroops;
      const actualTroops = Math.min(troops, maxTroops);
      const maxStop = Math.max(1, actualTroops - 1);
      if (ui.stopAtTroops != null) ui.stopAtTroops = Math.max(1, Math.min(maxStop, ui.stopAtTroops));
      const stopDisabled = actualTroops <= 1;
      sheet.innerHTML = attackConfirmationHtml(actualTroops, maxTroops, `${tn(p.from)} → ${tn(p.to)}`, stopDisabled ? null : ui.stopAtTroops);
      q('#atk-cancel').onclick = () => { ui.pendingAttack = null; ui.sel = null; ui.phase = 'commit'; draw(); };
      q('#atk-confirm').onclick = async () => { await onConfirmAttack(); };
      if (!stopDisabled) {
        const input = q<HTMLInputElement>('#atk-stop-input');
        const readStop = () => Math.max(1, Math.min(maxStop, Math.floor(Number(input.value)) || 1));
        const setStop = (value: number | null) => {
          ui.stopAtTroops = value;
          if (value != null && input.valueAsNumber !== value) input.value = String(value);
          q('#atk-stop-toggle').setAttribute('aria-pressed', String(value != null));
          q<HTMLButtonElement>('#atk-stop-off').disabled = value == null;
        };
        q('#atk-stop-toggle').onclick = () => setStop(readStop());
        q('#atk-stop-off').onclick = () => setStop(null);
        q('#atk-stop-minus').onclick = () => setStop(Math.max(1, (ui.stopAtTroops ?? maxStop) - 1));
        q('#atk-stop-plus').onclick = () => setStop(Math.min(maxStop, (ui.stopAtTroops ?? maxStop) + 1));
        input.oninput = () => {
          if (!Number.isInteger(input.valueAsNumber) || input.valueAsNumber < 1 || input.valueAsNumber > maxStop) return;
          setStop(input.valueAsNumber);
        };
        input.onchange = () => setStop(readStop());
      }
    } else if (ui.phase === 'move' && ui.move) {
      // Post-conquest troop movement
      const m = ui.move;
      const fromTroops = getScaledTroops(m.from);
      const minMove = m.minMove;
      const maxMove = Math.max(0, fromTroops - 1);
      const actualTroops = Math.min(m.troops, maxMove);
      sheet.innerHTML = movementPhaseHtml(actualTroops, minMove, maxMove, `${tn(m.from)} → ${tn(m.to)}`,
        ui.interactive?.lastResult ? battleResultsHtml(ui.interactive.lastResult.attack, tn, ui.battleResultsOpen) : '');
      q('#move-minus').onclick = () => { ui.move!.troops = Math.max(minMove, ui.move!.troops - 1); renderSheet(); };
      q('#move-plus').onclick = () => { ui.move!.troops = Math.min(maxMove, ui.move!.troops + 1); renderSheet(); };
      q('#move-input').oninput = () => { ui.move!.troops = Math.max(minMove, Math.min(maxMove, Number(q<HTMLInputElement>('#move-input').value) || minMove)); renderSheet(); };
      q('#move-set').onclick = () => { ui.move!.troops = Math.max(minMove, Math.min(maxMove, Number(q<HTMLInputElement>('#move-input').value) || minMove)); renderSheet(); };
      q('#move-min').onclick = () => { ui.move!.troops = minMove; renderSheet(); };
      q('#move-max').onclick = () => { ui.move!.troops = maxMove; renderSheet(); };
      q('#move-confirm').onclick = onConfirmMove;
    } else if (ui.phase === 'waiting') {
      const p = s.players[s.activePlayerIndex];
      sheet.innerHTML = `<div class="hint">${ui.sealing ? 'Resolving your turn…' : p ? `<b style="color:${color(s.activePlayerIndex)}">${p.name}</b> is moving…` : 'Working…'}</div>`;
    } else {
      const won = s.winnerIndex === me;
      sheet.innerHTML = gameOverPhaseHtml(won, s.phase === 'GAME_OVER' ? s.players[s.winnerIndex!].name : null, roundOf(s.turnNumber, s.activePlayerIndex), s.players.length);
      q('#menu').onclick = exit;
      if (s.phase === 'GAME_OVER') q('#stats').onclick = victory;
      if (s.phase !== 'GAME_OVER') q('#watch').onclick = async () => { await runBots(true); ui.phase = 'waiting'; await afterAction(); };
    }
    const results = sheet.querySelector<HTMLDetailsElement>('#battle-results');
    if (results) results.ontoggle = () => { ui.battleResultsOpen = results.open; };
    sheet.querySelectorAll<HTMLElement>('[data-go]').forEach(b => b.onclick = () => setPhase(b.dataset.go as Phase));
    sheet.querySelectorAll<HTMLElement>('[data-step]').forEach(b => b.onclick = () => {
      const step = Number(b.dataset.step);
      ui.step = step;
      // Update pending attack troop count when step changes during attack selection
      if (ui.phase === 'move' && ui.pendingAttack) {
        const maxTroops = getScaledTroops(ui.pendingAttack.from) - 1;
        if (step === 999) {
          ui.pendingAttack.troops = Math.min(maxTroops, getScaledTroops(ui.pendingAttack.from));
        } else {
          ui.pendingAttack.troops = Math.min(Math.max(1, step), maxTroops);
        }
      }
      renderSheet();
    });
  }

  function renderDrawer(): void {
    const s = S();
    q('#roster').innerHTML = commanderRosterHtml(s, me);
    q('#continents').innerHTML = continentIntelHtml(map, s);
    q('#log').innerHTML = ui.log.length ? ui.log.join('') : '<li class="miss">No turns played yet.</li>';
  }

  function describe(r: TurnResolutionResult): string[] {
    const who = `<span class="who" style="--pc:${color(r.playerIndex)}">${S().players[r.playerIndex].name}</span>`;
    const lines = r.attackLogs.filter(l => !l.skippedReason).map(l =>
      `<li>${who} ${tn(l.fromTerritoryId)} → ${tn(l.toTerritoryId)} · ${l.waves.length} roll${l.waves.length === 1 ? '' : 's'} · ${l.conquered ? '<span class="cap">CAPTURED</span>' : '<span class="miss">held</span>'}</li>`);
    return [`<li>${who} <b>T${roundOf(r.turnNumber, r.playerIndex)}</b> +${r.reinforcements.total} troops${r.cardDrawn ? ' · drew a card' : ''}</li>`, ...lines];
  }

  /* ------------------------------ interaction ------------------------------ */
  let toastTimer = 0;
  function toast(msg: string): void {
    const t = q('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = window.setTimeout(() => t.classList.remove('show'), 1800);
  }
  let pillTimer = 0;
  function pill(id: TerritoryId): void {
    const s = S(); const t = map.territories[id]; const c = map.continents[t.continentId];
    const p = q('#pill');
    p.style.setProperty('--pc', color(s.territories[id].owner));
    p.innerHTML = territoryPillHtml(t.name, s.players[s.territories[id].owner].name, c.name, c.bonus, projectedTroops()[id]);
    p.hidden = false;
    clearTimeout(pillTimer); pillTimer = window.setTimeout(() => { p.hidden = true; }, 2500);
  }

  function place(m: Map<TerritoryId, number>, id: TerritoryId, left: number): void {
    if (!owns(id)) return toast('Place troops on your own territories');
    if (left <= 0) return toast('No troops left to place');
    m.set(id, (m.get(id) ?? 0) + Math.min(ui.step, left));
  }

  function onTap(target: Element): void {
    const g = target.closest('.terr');
    if (!g) { ui.sel = null; draw(); return; }
    const id = Number(g.getAttribute('data-t'));
    pill(id);
    if (ui.phase === 'setup') place(ui.setup, id, setupLeft());
    else if (ui.phase === 'draft') place(ui.draft, id, draftLeft());
    else if (ui.phase === 'attack') {
      const pending = pendingCaptures();
      const isSource = (x: TerritoryId) => (owns(x) && projectedTroops()[x] >= 2) || pending.has(x);
      if (ui.sel === null) {
        if (!owns(id) && !pending.has(id)) return void toast('Tap one of your territories first');
        if (!isSource(id)) return void toast('Need at least 2 troops to attack');
        ui.sel = id;
      } else if (id === ui.sel) ui.sel = null;
      else if (validTargets()!.has(id)) {
        ui.attacks.push({ orderId: `a${ui.attacks.length + 1}-${ui.sel}-${id}`, fromTerritoryId: ui.sel, toTerritoryId: id, stopWhenAttackerAtOrBelow: 2, occupyMode: { type: 'ALL_BUT_ONE' }, chain: !owns(ui.sel) });
        toast(`Queued #${ui.attacks.length}: ${tn(ui.sel)} → ${tn(id)}`);
        ui.sel = null;
      } else if (isSource(id)) ui.sel = id;
      else return void toast('Target must border your selection');
    } else if ((ui.phase === 'commit' || ui.phase === 'interactive_attack') && ui.interactive) {
      // Interactive attack mode: select source → target → set troops
      if (ui.sel === null) {
        // Select source territory (must own it and have ≥2 troops)
        if (!owns(id)) return void toast('Tap one of your territories first');
        const troops = getScaledTroops(id);
        if (troops < 2) return void toast('Need at least 2 troops to attack');
        ui.sel = id;
      } else if (id === ui.sel) {
        // Deselect
        ui.sel = null;
      } else if (map.territories[id].neighbors.includes(ui.sel!) || map.territories[ui.sel!].neighbors.includes(id)) {
        // Target can be any adjacent territory (enemy or own)
        if (id === ui.sel) return;
        const sourceTroops = getScaledTroops(ui.sel!);
        const pending = pendingCaptures();
        const isSource = (x: TerritoryId) => (owns(x) && getScaledTroops(x) >= 2) || pending.has(x);
        if (isSource(id)) {
          // This is a valid source — allow it as a re-target
          ui.sel = id;
          ui.pendingAttack = null;
        } else if (owns(id)) {
          // Own territory with <2 troops — re-select as source candidate
          ui.sel = id;
          ui.pendingAttack = null;
        } else {
          // It's an enemy target
          ui.pendingAttack = { from: ui.sel, to: id, troops: sourceTroops };
          ui.phase = 'move'; // show slider for troop count
        }
        draw();
      } else {
        return void toast('Target must be adjacent');
      }
      draw();
    } else if (ui.phase === 'move') {
      // Move step: tap destination to confirm move
      if (ui.sel && map.territories[ui.sel].neighbors.includes(id)) {
        if (id === ui.sel) {
          ui.sel = null;
          draw();
          return;
        }
        // Select this as move destination
        ui.sel = id;
        draw();
      } else {
        return void toast('Must be adjacent to source');
      }
    } else if (ui.phase === 'fortify') {
      if (!owns(id)) return void toast('Fortify between your own territories');
      const live = ui.interactive ? ui.interactive.state.liveState : S();
      if (ui.sel === null) {
        const troopsHere = ui.interactive ? getScaledTroops(id) : projectedTroops()[id];
        if (troopsHere < 2) return void toast('Need at least 2 troops to move');
        ui.sel = id;
      } else if (id === ui.sel) ui.sel = null;
      else if (connectedOwned(map, live, me, ui.sel).has(id)) {
        const sourceTroops = ui.interactive ? getScaledTroops(ui.sel) : projectedTroops()[ui.sel];
        ui.fortify = { fromTerritoryId: ui.sel, toTerritoryId: id, troops: sourceTroops - 1 };
        ui.sel = null;
      } else return void toast('Must be connected through your territories');
    }
    draw();
  }

  function removeAttack(index: number): void {
    // Dropping an attack also drops chained attacks that relied on capturing its target.
    const drop = new Set([index]);
    for (let grew = true; grew;) {
      grew = false;
      ui.attacks.forEach((a, i) => {
        if (!drop.has(i) && a.chain && [...drop].some(d => ui.attacks[d].toTerritoryId === a.fromTerritoryId)) { drop.add(i); grew = true; }
      });
    }
    ui.attacks = ui.attacks.filter((_, i) => !drop.has(i));
  }

  function setPhase(p: Phase): void {
    ui.phase = p;
    ui.sel = null;
    draw();
  }

  function resetPlan(): void {
    ui.trades = []; ui.draft.clear(); ui.attacks = []; ui.fortify = null; ui.sel = null;
    ui.interactive = null; ui.move = null; ui.pendingAttack = null; ui.handSnapshot = null;
  }

  async function deploy(): Promise<void> {
    await game.submitSetupPlacement({ type: 'SETUP_PLACEMENT', playerIndex: me, placements: [...ui.setup].map(([territoryId, troops]) => ({ territoryId, troops })) });
    ui.setup.clear();
    opts.onChange?.(game);
    await afterAction();
  }

  /** Sleep that ends early when the user taps SKIP. */
  function beat(ms: number): Promise<void> {
    if (ui.skip || !ui.alive) return Promise.resolve();
    return new Promise(res => {
      const t = window.setTimeout(done, ms);
      function done() { clearTimeout(t); ui.wake = null; res(); }
      ui.wake = done;
    });
  }

  /** Shows the commit → witness reveal handshake (it's real: the reveal is the witness's next hash-chain secret). */
  async function sealOverlay(outcome: TurnOutcome): Promise<void> {
    const o = q('#overlay');
    const w = outcome.reveal.payload.witnessIndex;
    const steps = [
      `<div class="ring"></div><h2>SEALING TURN</h2><code>commit ${outcome.commit.id.slice(0, 16)}…</code><p>Your plan is signed. Nobody knows the dice yet.</p>`,
      `<div class="ring" style="--pc:${color(w)}"></div><h2>AWAITING REVEAL</h2><p><b style="color:${color(w)}">${S().players[w].name}</b> reveals their next hash-chain secret</p>`,
      `<h2 style="color:var(--lime)">SEED REVEALED ✓</h2><code>secret ${outcome.reveal.payload.revealedSecret.slice(0, 16)}…</code><p>Dice = SHA-256(commit : secret)</p>`,
    ];
    o.classList.add('show');
    o.onclick = () => { ui.skip = true; ui.wake?.(); };
    for (const html of steps) { o.innerHTML = html; await beat(700); }
    o.classList.remove('show');
    o.onclick = null;
  }

  /** Only bot replays take control of the camera; player actions keep the current view. */
  async function playReplay(before: GameState, outcome: TurnOutcome): Promise<void> {
    const frames = buildReplay(map, before, outcome.resolution, roundOf(outcome.resolution.turnNumber, outcome.resolution.playerIndex));
    const followBot = before.players[outcome.resolution.playerIndex].isBot;
    ui.phase = 'replay';
    ui.replayWho = outcome.resolution.playerIndex;
    ui.replayTurn = outcome.resolution.turnNumber;
    if (followBot && !ui.skip && ui.alive) {
      camera.fitAnimated();
      await beat(320);
    }
    for (const f of frames) {
      if (ui.skip || !ui.alive) break;
      ui.frame = f;
      draw();
      if (followBot && f.focus?.length) camera.focusOn(f.focus.map(id => territoryPoint(map, id, true)));
      await beat((BEAT_MS * f.weight) / ui.speed);
    }
    ui.frame = null;
    if (followBot && ui.alive) {
      if (!ui.skip) {
        camera.fitAnimated();
        await beat(320);
      }
      camera.fit();
    }
    ui.skip = false;
  }

  async function commitTurn(): Promise<void> {
    const plan = buildPlan();
    const before = S();

    // If user has queued attacks, use batch resolution
    if (ui.attacks.length > 0) {
      ui.phase = 'waiting';
      draw();
      const outcome = await game.submitTurnCommit(plan);
      ui.phase = 'waiting';
      draw();
      await sealOverlay(outcome);
      await playReplay(before, outcome);
      await afterAction();
      return;
    }

    // Interactive flow: draft complete, enter interactive attack selection
    try {
      console.log('[commitTurn] plan.cardTrades:', JSON.stringify(plan.cardTrades));
      console.log('[commitTurn] hand:', S().players[me].cards.map(c => ({ id: c.id, emblem: c.emblem, territoryId: c.territoryId })));
      console.log('[commitTurn] ui.trades:', JSON.stringify(ui.trades));
      // Snapshot hand before startInteractiveTurn removes traded cards
      ui.handSnapshot = S().players[me].cards.slice();
      const interactiveState = game.startInteractiveTurn(plan);
      ui.interactive = { state: interactiveState, lastResult: null };
      ui.phase = 'interactive_attack';
      draw();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
      return;
    }
  }

  /** Queue an attack and resolve it. */
  async function onConfirmAttack(): Promise<void> {
    if (!ui.pendingAttack || !ui.interactive) return;
    const { from, to, troops } = ui.pendingAttack;
    const maxTroops = getScaledTroops(from) - 1;
    const actualTroops = Math.min(troops, maxTroops);
    if (actualTroops < 1) return toast('Must attack with at least 1 troop');

    const maxAttackers = Math.min(3, actualTroops);
    const stopThreshold = attackStopThreshold(actualTroops > 1 ? ui.stopAtTroops : null);
    const order: AttackCampaignOrder = {
      orderId: `interactive-${Date.now()}`,
      fromTerritoryId: from,
      toTerritoryId: to,
      attackerDice: maxAttackers,
      stopWhenAttackerAtOrBelow: stopThreshold,
      occupyMode: { type: 'NONE' }, // No auto-move; user chooses in move step
    };

    const { result, state } = game.executeInteractiveAttack(ui.interactive.state, order);
    console.log('attack result:', result);

    // Check if conquered
    if (result.attack.conquered) {
      // Enter move step: user chooses how many troops to move into conquered territory
      // Minimum = attacker dice count (how many you attacked with), max = all but one from source
      const lastWave = result.attack.waves[result.attack.waves.length - 1];
      const minMove = lastWave?.attackerDice?.length ?? maxAttackers;
      const srcTroops = state.liveState.territories[from].troops;
      const maxMove = Math.max(0, srcTroops - 1);
      ui.interactive = { state, lastResult: result };
      ui.move = { from, to, troops: maxMove, minMove, maxMove };
      ui.pendingAttack = null; // clear so move-phase rendering fires, not pending-attack rendering
      ui.phase = 'move';
      ui.sel = to;
      draw();
    } else {
      // Attack failed — go back to attack selection
      ui.interactive = { state, lastResult: result };
      ui.phase = 'commit';
      ui.sel = null;
      ui.pendingAttack = null;
      draw();
    }
  }

  /** Called when user confirms troop count in move step. */
  async function onConfirmMove(): Promise<void> {
    if (!ui.interactive || !ui.move) { console.log('[onConfirmMove] early return: interactive=', !!ui.interactive, 'move=', !!ui.move); return; }
    const { from, to, troops } = ui.move;
    console.log('[onConfirmMove] from=', from, 'to=', to, 'troops=', troops);
    console.log('[onConfirmMove] move.minMove=', ui.move.minMove);
    console.log('[onConfirmMove] source troops=', getScaledTroops(from));
    const newState = game.moveTroopsToConquered(ui.interactive.state, from, to, troops);
    console.log('[onConfirmMove] result: troops after move=', getScaledTroops(to));
    ui.interactive = { state: newState.state, lastResult: ui.interactive.lastResult };
    ui.move = null;
    ui.sel = null;

    if (newState.state.liveState.territories.every(t => t.owner === me)) {
      await onCompleteAttack();
      return;
    }

    // Check if stopAtTroops target is met
    if (ui.stopAtTroops != null) {
      const currentTroops = Math.max(0, getScaledTroops(from) - 1);
      if (currentTroops <= ui.stopAtTroops) {
        // Pause campaign — show STOP button
        ui.phase = 'commit';
        ui.pendingAttack = null;
        draw();
        // Show pause banner
        const sheet = q('#sheet');
        sheet.innerHTML = `
          <div class="big"><span class="n" style="color:var(--yellow)">⏸</span><span class="t">STOPPED<small>Source at ${currentTroops} / ${ui.stopAtTroops} attacking armies</small></span></div>
          <div class="actions">
            <button class="btn" id="atk-cancel">CANCEL CAMPAIGN</button>
            <button class="primary btn" id="atk-resume">RESUME ▸</button>
          </div>`;
        q('#atk-cancel').onclick = () => {
          ui.stopAtTroops = null;
          ui.phase = 'commit';
          ui.interactive = null;
          draw();
        };
        q('#atk-resume').onclick = () => {
          ui.stopAtTroops = null;
          ui.phase = 'commit';
          ui.sel = null;
          ui.pendingAttack = null;
          draw();
        };
        return;
      }
    }

    ui.phase = 'commit'; // back to attack selection
    draw();
  }

  /** Go back to attack selection from attack result view. */
  function onAttackNext(): void {
    ui.sel = null;
    ui.pendingAttack = null;
    draw();
  }

  /** Transition to fortify phase. */
  function onFortifyNow(): void {
    ui.phase = 'fortify';
    ui.sel = null;
    draw();
  }

  /** Complete the attack step and transition to fortify. */
  async function onCompleteAttack(): Promise<void> {
    if (!ui.interactive) return;
    // Apply fortify if planned
    if (ui.fortify && !ui.interactive.state.liveState.territories.every(t => t.owner === me)) {
      const newState = game.executeInteractiveFortify(ui.interactive.state, ui.fortify);
      ui.interactive = { state: newState.state, lastResult: ui.interactive.lastResult };
    }
    // Finish the turn
    const outcome = game.finishInteractiveTurn(ui.interactive.state);
    ui.interactive = null;
    ui.fortify = null;
    ui.phase = 'waiting';
    opts.onChange?.(game);
    ui.skip = false;
    if (outcome.resolution.newState.phase !== 'GAME_OVER') await sealOverlay(outcome);
    await afterAction();
  }

  /** Runs bot turns until it's the human's turn or the game ends. */

  async function runBots(fast = false): Promise<void> {
    ui.phase = 'waiting';
    draw();
    while (ui.alive && game.isBotTurn()) {
      const before = S();
      const outcome = await game.playBotTurn();
      if (!outcome) break;
      opts.onChange?.(game);
      if (fast || ui.autoSkipBots) { draw(); await new Promise(r => setTimeout(r, fast ? 0 : 120)); }
      else await playReplay(before, outcome);
      ui.phase = 'waiting';
    }
    draw();
  }

  async function afterAction(): Promise<void> {
    if (game.isBotTurn() && !S().players[me].eliminated) await runBots();
    if (!ui.alive) return;
    const s = S();
    if (s.phase === 'GAME_OVER' || s.players[me].eliminated) {
      const first = ui.phase !== 'over';
      ui.phase = 'over';
      if (first && s.phase === 'GAME_OVER') { draw(); victory(); return; }
    }
    else if (game.isLocalTurn()) { resetPlan(); ui.phase = 'draft'; }
    draw();
  }

  function victory(): void {
    showVictory(q('.game'), game, { onMenu: exit, onLog: () => openEventInspector(q('.game'), game) });
  }

  function exit(): void {
    ui.alive = false;
    opts.onExit();
  }

  /* ------------------------------ wiring ------------------------------ */
  q('#open-drawer').onclick = () => q('#drawer').classList.add('open');
  q('#drawer').onclick = e => { if ((e.target as HTMLElement).id === 'drawer') q('#drawer').classList.remove('open'); };
  q('#exit').onclick = () => { if (S().phase === 'GAME_OVER' || confirm('Leave this game? It is saved — continue it from the menu.')) exit(); };
  q('#fit').onclick = () => camera.fit();
  q('#event-log').onclick = () => { q('#drawer').classList.remove('open'); openEventInspector(q('.game'), game); };
  const autoSkip = q<HTMLInputElement>('#auto-skip');
  autoSkip.checked = ui.autoSkipBots;
  autoSkip.onchange = () => { ui.autoSkipBots = autoSkip.checked; localStorage.setItem('nd.autoSkipBots', autoSkip.checked ? '1' : '0'); };
  q('#phases').querySelectorAll<HTMLElement>('button').forEach(b => b.onclick = () => {
    if (ui.interactive) return toast('Complete your interactive attacks first');
    const target = b.dataset.p as 'draft' | 'attack' | 'fortify' | 'commit';
    if (target !== 'draft' && (draftLeft() !== 0 || tradeRequired())) return toast('Place all your troops first');
    const curIdx = PLAN_PHASES.indexOf(ui.phase as typeof PLAN_PHASES[number]);
    const tgtIdx = PLAN_PHASES.indexOf(target);
    if (curIdx < 0 || tgtIdx > curIdx + 1) return toast('Follow the turn order');
    setPhase(target);
  });
  const resize = new ResizeObserver(() => draw());
  resize.observe(board);

  // Desktop keyboard shortcuts (ignored while typing or when a modal is open).
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('.cards-help summary') && (e.key === 'Enter' || e.key === ' ')) return;
    const modal = root.querySelector('.modal');
    if (e.key === 'Escape') {
      if (modal) modal.remove(); else if (q('#drawer').classList.contains('open')) q('#drawer').classList.remove('open'); else { ui.sel = null; draw(); }
      return;
    }
    if (modal) return;
    const k = e.key.toLowerCase();
    if (ui.phase === 'replay' && (k === ' ' || k === 'enter')) { e.preventDefault(); ui.skip = true; ui.wake?.(); return; }
    if (q('#overlay').classList.contains('show') && k === ' ') { e.preventDefault(); ui.skip = true; ui.wake?.(); return; }
    if (k === 'enter') { e.preventDefault(); root.querySelector<HTMLButtonElement>('#sheet .primary:not([disabled])')?.click(); }
    else if (['1', '2', '3', '4'].includes(k) && !q('#phases').hidden) q('#phases').querySelectorAll<HTMLButtonElement>('button')[Number(k) - 1].click();
    else if (k === 'u') root.querySelector<HTMLButtonElement>('#undo')?.click();
    else if (k === '0') camera.fit();
    else if (k === 'l') openEventInspector(q('.game'), game);
  };
  addEventListener('keydown', onKey);

  const s0 = S();
  if (s0.phase === 'SETUP_PLACEMENT' && !s0.players[me].setupDone) ui.phase = 'setup';
  else if (s0.phase === 'GAME_OVER' || s0.players[me].eliminated) ui.phase = 'over';
  else if (game.isLocalTurn()) ui.phase = 'draft';
  else { ui.phase = 'waiting'; void afterAction(); }
  draw(true);
  if (s0.phase === 'GAME_OVER') victory();

  return () => { ui.alive = false; resize.disconnect(); offTurn(); removeEventListener('keydown', onKey); root.innerHTML = ''; };
}

const GAME_HTML = `
<div class="game">
  <header class="g-top">
    <button class="icon" id="open-drawer" aria-label="Intel">☰</button>
    <div class="g-turn"><small>TURN</small><b id="turn">—</b></div>
    <div class="g-players" id="players"></div>
    <button class="icon" id="fit" aria-label="Fit map">⤢</button>
  </header>
  <main class="board" id="board"><svg id="map" role="img" aria-label="Game map"></svg><div class="pill glass" id="pill" hidden></div><div class="toast" id="toast"></div></main>
  <nav class="g-phases" id="phases" hidden>
    <button data-p="draft">DRAFT<i id="badge-draft"></i></button>
    <button data-p="attack">ATTACK<i id="badge-attack"></i></button>
    <button data-p="fortify">FORTIFY</button>
    <button data-p="commit">END TURN</button>
  </nav>
  <section class="sheet glass" id="sheet"></section>
  <div class="drawer" id="drawer"><div class="drawer-panel glass">
    <h3>COMMANDERS</h3><ul id="roster"></ul>
    <h3>CONTINENTS</h3><ul id="continents"></ul>
    <h3>SETTINGS</h3><label class="setting"><input type="checkbox" id="auto-skip"> Auto-skip bot replays</label>
    <p class="keys">Keys: <b>1–4</b> phases · <b>Enter</b> next/commit · <b>U</b> undo · <b>Space</b> skip replay · <b>0</b> fit · <b>L</b> log · <b>Esc</b> cancel</p>
    <details class="log-wrap" id="log-wrap"><summary>BATTLE LOG</summary><ul class="log" id="log"></ul></details>
    <button class="btn exit" id="event-log">📜 EVENT LOG</button>
    <button class="btn exit" id="exit">◂ MENU</button>
  </div></div>
  <div class="overlay" id="overlay"></div>
  <div class="debug-overlay" id="debug-overlay" hidden></div>
</div>`;
