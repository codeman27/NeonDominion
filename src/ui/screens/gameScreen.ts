import '../styles/game.css';
import { connectedOwned } from '../../engine/fortify';
import { bestSet, mustTrade } from '../../engine/rules';
import { computeReinforcements, validateTurnPlan } from '../../engine/turnEngine';
import type { TurnOutcome } from '../../transport/transport';
import type { LocalGame } from '../../transport/localTransport';
import type { AttackCampaignOrder, CardTradeOrder, FortifyOrder, OccupyMode, TurnActionPlan } from '../../types/actions';
import type { GameState, TerritoryCard, TerritoryId } from '../../types/game';
import { buildReplay, type ReplayFrame } from '../components/battleReplay';
import { renderMap, territoryPoint, type MapArrow } from '../components/hexMapRenderer';
import { MapCamera } from '../components/mapCamera';
import { NEON } from '../theme';

type Phase = 'setup' | 'draft' | 'attack' | 'fortify' | 'commit' | 'waiting' | 'replay' | 'over';
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

  const ui = {
    phase: 'setup' as Phase,
    step: 1,
    sel: null as TerritoryId | null,
    setup: new Map<TerritoryId, number>(),
    trades: [] as CardTradeOrder[],
    draft: new Map<TerritoryId, number>(),
    attacks: [] as PlannedAttack[],
    fortify: null as FortifyOrder | null,
    rotated: false,
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
  };

  const camera = new MapCamera(board, svg, onTap, z => svg.classList.toggle('zoomed', z > 1.5));
  const offTurn = game.onTurnResolved(o => { ui.log.unshift(...describe(o)); ui.log.length = Math.min(ui.log.length, 60); });

  /* ------------------------------ derived values ------------------------------ */
  const owns = (id: TerritoryId) => S().territories[id].owner === me;
  const sum = (m: Map<TerritoryId, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const hand = (): TerritoryCard[] => S().players[me].cards;
  const tradedIds = () => new Set(ui.trades.flatMap(t => t.cardIds));
  const tradeCards = () => ui.trades.map(t => t.cardIds.map(id => hand().find(c => c.id === id)!));
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

  function validTargets(): Set<TerritoryId> | null {
    if (ui.sel === null) return null;
    if (ui.phase === 'attack') {
      const taken = pendingCaptures();
      return new Set(map.territories[ui.sel].neighbors.filter(n => !owns(n) && !taken.has(n)));
    }
    if (ui.phase === 'fortify') return connectedOwned(map, S(), me, ui.sel);
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
    const portrait = board.clientHeight > board.clientWidth * 1.1;
    const f = ui.frame;
    let arrows: MapArrow[] = ui.attacks.map((a, i) => ({ from: a.fromTerritoryId, to: a.toTerritoryId, kind: 'attack', label: String(i + 1) }));
    if (ui.fortify) arrows.push({ from: ui.fortify.fromTerritoryId, to: ui.fortify.toTerritoryId, kind: 'fortify', label: 'F' });
    let boosted = new Set([...(ui.phase === 'setup' ? ui.setup.keys() : ui.draft.keys())]);
    if (f) { arrows = f.arrow ? [f.arrow] : []; boosted = new Set(f.boosted ?? []); }
    const box = renderMap(svg, map, {
      colorMode: 'owner', owners: f ? f.owners : S().territories.map(t => t.owner), troops: f ? f.troops : projectedTroops(), rotate: portrait,
      selected: f ? null : ui.sel, highlight: f ? null : validTargets(), boosted, arrows,
    });
    camera.setFitBox(box, refit || portrait !== ui.rotated);
    ui.rotated = portrait;
    renderTop();
    renderSheet();
    renderDrawer();
  }

  function renderTop(): void {
    const s = S();
    const replaying = ui.phase === 'replay' && ui.frame;
    const turn = replaying ? ui.replayTurn : s.turnNumber;
    const active = replaying ? ui.replayWho : s.phase === 'ACTIVE_TURN_COMMIT' ? s.activePlayerIndex : -1;
    const owners = ui.frame ? ui.frame.owners : s.territories.map(t => t.owner);
    q('#turn').textContent = turn ? String(turn).padStart(2, '0') : '—';
    q('#players').innerHTML = s.players.map((p, i) => {
      const n = owners.filter(o => o === i).length;
      return `<span class="${i === active ? 'active' : ''} ${p.eliminated && !n ? 'out' : ''}" style="--pc:${color(i)}" title="${p.name}">${n}</span>`;
    }).join('');
    const phases = q('#phases');
    phases.hidden = !PLAN_PHASES.includes(ui.phase as typeof PLAN_PHASES[number]);
    const idx = PLAN_PHASES.indexOf(ui.phase as typeof PLAN_PHASES[number]);
    phases.querySelectorAll('button').forEach((b, i) => { b.classList.toggle('active', i === idx); b.classList.toggle('done', i < idx); });
    q('#badge-draft').textContent = idx >= 0 && draftLeft() ? String(draftLeft()) : '';
    q('#badge-attack').textContent = ui.attacks.length ? String(ui.attacks.length) : '';
  }

  const stepToggle = () => `<div class="step-toggle">${[1, 5].map(n => `<button data-step="${n}" class="${ui.step === n ? 'on' : ''}">×${n}</button>`).join('')}<button data-step="999" class="${ui.step === 999 ? 'on' : ''}">ALL</button></div>`;

  function renderSheet(): void {
    const sheet = q('#sheet');
    const s = S();
    const next = (p: Phase, label: string, disabled = false) => `<button class="primary btn" data-go="${p}" ${disabled ? 'disabled' : ''}>${label} ▸</button>`;
    const back = (p: Phase) => `<button class="btn ghost" data-go="${p}">◂</button>`;

    if (ui.phase === 'setup') {
      const chips = [...ui.setup].map(([id, n]) => `<span>${tn(id)}<b>+${n}</b></span>`).join('') || '<span class="empty">Tap your territories to place troops</span>';
      sheet.innerHTML = `
        <div class="big"><span class="n">${setupLeft()}</span><span class="t">STARTING TROOPS<small>Fortify your borders before turn 1</small></span>${stepToggle()}</div>
        <div class="chips">${chips}</div>
        <div class="actions"><button class="btn ghost" id="undo">UNDO</button><button class="primary btn" id="deploy" ${setupLeft() ? 'disabled' : ''}>DEPLOY ▸</button></div>`;
      q('#undo').onclick = () => { ui.setup.clear(); draw(); };
      q('#deploy').onclick = deploy;
    } else if (ui.phase === 'draft') {
      const r = reinf();
      const traded = tradedIds();
      const remaining = hand().filter(c => !traded.has(c.id));
      const set = bestSet(remaining);
      const cards = hand().map(c => `<span class="card ${c.emblem} ${traded.has(c.id) ? 'traded' : ''}" title="${c.territoryId === null ? 'WILD' : tn(c.territoryId)}">${c.emblem.slice(0, 3)}</span>`).join('');
      const chips = [...ui.draft].map(([id, n]) => `<span>${tn(id)}<b>+${n}</b></span>`).join('') || '<span class="empty">Tap your territories to place troops</span>';
      const parts = [`${r.base} base`, r.continentBonus ? `${r.continentBonus} continents` : '', r.cardTradeBonus ? `${r.cardTradeBonus} cards` : ''].filter(Boolean).join(' + ');
      sheet.innerHTML = `
        <div class="big"><span class="n">${draftLeft()}</span><span class="t">TROOPS TO PLACE<small>${parts}${r.matchTerritories.length ? ` · +2 on ${r.matchTerritories.map(tn).join(', ')}` : ''}</small></span>${stepToggle()}</div>
        ${hand().length ? `<div class="hand">${cards}<button class="chip-btn" id="trade" ${set ? '' : 'disabled'}>${set ? `TRADE +${set.value}` : 'NO SET'}</button></div>` : ''}
        ${tradeRequired() ? '<div class="hint warn">5+ cards: you must trade a set before continuing.</div>' : ''}
        <div class="chips">${chips}</div>
        <div class="actions"><button class="btn ghost" id="undo">UNDO</button>${next('attack', 'ATTACK', draftLeft() !== 0 || tradeRequired())}</div>`;
      q('#undo').onclick = () => { ui.draft.clear(); ui.trades = []; draw(); };
      if (set) q('#trade').onclick = () => { ui.trades.push({ cardIds: set.cardIds }); draw(); toast(`Traded a set for +${set.value} troops`); };
    } else if (ui.phase === 'attack') {
      const rows = ui.attacks.map((a, i) => `
        <div class="atk-item ${a.chain ? 'chain' : ''}"><span class="no">${i + 1}</span>
          <span class="p">${a.chain ? '↳ ' : ''}${tn(a.fromTerritoryId)}<em>→</em>${tn(a.toTerritoryId)}</span>
          <button class="o" data-stop="${i}" title="Stop when attackers drop to">STOP≤${a.stopWhenAttackerAtOrBelow}</button>
          <button class="o" data-occ="${i}" title="Troops to move in">${OCCUPY.find(o => o.mode.type === a.occupyMode.type)!.label}</button>
          <button class="x" data-rm="${i}" aria-label="Remove">×</button></div>`).join('');
      sheet.innerHTML = `
        <div class="hint">${ui.sel === null ? 'Tap <b>your territory</b>, then a <b>pulsing enemy</b>. Captured targets can attack again (chain).' : `From <b>${tn(ui.sel)}</b>: tap a pulsing target`}</div>
        <div class="atk-list">${rows || '<div class="note">No attacks queued. Dice are rolled only after you commit.</div>'}</div>
        <div class="actions">${back('draft')}${next('fortify', 'FORTIFY')}</div>`;
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
      const max = f ? projectedTroops()[f.fromTerritoryId] - 1 : 0;
      sheet.innerHTML = `
        <div class="hint">${ui.sel === null ? 'Optional: tap a <b>source</b>, then any <b>connected</b> territory of yours. Runs after your attacks.' : `From <b>${tn(ui.sel)}</b>: tap a pulsing destination`}</div>
        ${f ? `<div class="fort">${tn(f.fromTerritoryId)}<em>⇢</em>${tn(f.toTerritoryId)}<div class="stepper"><button id="f-m">−</button><b>${f.troops}</b><button id="f-p">+</button></div></div>` : '<div class="note">One move per turn. Skip if your lines are fine.</div>'}
        <div class="actions">${back('attack')}${f ? '<button class="btn" id="f-clear">CLEAR</button>' : ''}${next('commit', 'REVIEW')}</div>`;
      if (f) {
        q('#f-m').onclick = () => { f.troops = Math.max(1, f.troops - 1); renderSheet(); };
        q('#f-p').onclick = () => { f.troops = Math.min(max, f.troops + 1); renderSheet(); };
        q('#f-clear').onclick = () => { ui.fortify = null; draw(); };
      }
    } else if (ui.phase === 'commit') {
      const errors = validateTurnPlan(map, s, buildPlan());
      sheet.innerHTML = `
        <div class="summary"><div><b>${sum(ui.draft)}</b><small>PLACED</small></div><div><b>${ui.attacks.length}</b><small>ATTACKS</small></div><div><b>${ui.fortify ? 1 : 0}</b><small>FORTIFY</small></div></div>
        <div class="note">${errors.length ? `<span style="color:var(--sun)">${errors[0]}</span>` : 'Your whole turn gets signed and locked. Dice stay sealed until the next commander reveals their seed.'}</div>
        <div class="actions">${back('fortify')}<button class="primary btn" id="commit" ${errors.length ? 'disabled' : ''}>COMMIT TURN</button></div>`;
      q('#commit').onclick = commitTurn;
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
      sheet.innerHTML = `
        <div class="rp-head" style="--pc:${color(ui.replayWho)}"><span class="sw"></span><b>${s.players[ui.replayWho].name}</b><small>TURN ${ui.replayTurn}</small>
          <div class="rp-ctl">${[1, 2].map(n => `<button data-speed="${n}" class="${ui.speed === n ? 'on' : ''}">${n}×</button>`).join('')}<button id="rp-skip">SKIP ▸▸</button></div></div>
        <div class="rp-cap ${f.tone ?? ''}">${f.caption}</div>${dice}
        <div class="rp-sub">${f.sub ?? ''}</div>`;
      q('#rp-skip').onclick = () => { ui.skip = true; ui.wake?.(); };
      sheet.querySelectorAll<HTMLElement>('[data-speed]').forEach(b => b.onclick = () => {
        ui.speed = Number(b.dataset.speed); localStorage.setItem('nd.speed', String(ui.speed)); renderSheet();
      });
    } else if (ui.phase === 'waiting') {
      const p = s.players[s.activePlayerIndex];
      sheet.innerHTML = `<div class="hint">${ui.sealing ? 'Resolving your turn…' : p ? `<b style="color:${color(s.activePlayerIndex)}">${p.name}</b> is moving…` : 'Working…'}</div>`;
    } else {
      const won = s.winnerIndex === me;
      sheet.innerHTML = `
        <div class="big"><span class="n" style="color:${won ? 'var(--lime)' : 'var(--mag)'}">${won ? '★' : '✕'}</span><span class="t">${s.phase === 'GAME_OVER' ? (won ? 'VICTORY' : `${s.players[s.winnerIndex!].name} WINS`) : 'YOU WERE ELIMINATED'}<small>Turn ${s.turnNumber} · ${s.players.length} commanders</small></span></div>
        <div class="actions">${s.phase === 'GAME_OVER' ? '' : '<button class="btn" id="watch">FINISH ▸▸</button>'}<button class="primary btn" id="menu">MENU</button></div>`;
      q('#menu').onclick = exit;
      if (s.phase !== 'GAME_OVER') q('#watch').onclick = () => { void runBots(true); };
    }
    sheet.querySelectorAll<HTMLElement>('[data-go]').forEach(b => b.onclick = () => setPhase(b.dataset.go as Phase));
    sheet.querySelectorAll<HTMLElement>('[data-step]').forEach(b => b.onclick = () => { ui.step = Number(b.dataset.step); renderSheet(); });
  }

  function renderDrawer(): void {
    const s = S();
    q('#roster').innerHTML = s.players.map((p, i) => {
      const terr = s.territories.filter(t => t.owner === i);
      return `<li class="roster-row ${i === s.activePlayerIndex ? 'active' : ''} ${p.eliminated ? 'out' : ''}" style="--pc:${color(i)}"><span class="sw"></span>
        <span class="nm">${p.name}${i === me && p.name !== 'YOU' ? ' (YOU)' : ''}</span>
        <span class="st"><span>${terr.length}<em>TER</em></span><span>${terr.reduce((a, t) => a + t.troops, 0)}<em>TRP</em></span><span>${p.cards.length}<em>CRD</em></span></span></li>`;
    }).join('');
    q('#continents').innerHTML = map.continents.map(c => {
      const counts = new Array(s.players.length).fill(0);
      c.territoryIds.forEach(id => counts[s.territories[id].owner]++);
      const lead = counts.indexOf(Math.max(...counts));
      return `<li class="cont-row" style="--cc:${NEON.continents[c.id % NEON.continents.length]};--pc:${color(lead)}"><span class="sw"></span><span>${c.name}</span><span class="bn">+${c.bonus}</span>
        <span class="bar"><span style="width:${(counts[lead] * 100) / c.territoryIds.length}%"></span></span><span class="own">${counts[lead]}/${c.territoryIds.length} ${s.players[lead].name}</span></li>`;
    }).join('');
    q('#log').innerHTML = ui.log.length ? ui.log.join('') : '<li class="miss">No turns played yet.</li>';
  }

  function describe(o: TurnOutcome): string[] {
    const r = o.resolution;
    const who = `<span class="who" style="--pc:${color(r.playerIndex)}">${S().players[r.playerIndex].name}</span>`;
    const lines = r.attackLogs.filter(l => !l.skippedReason).map(l =>
      `<li>${who} ${tn(l.fromTerritoryId)} → ${tn(l.toTerritoryId)} · ${l.waves.length} roll${l.waves.length === 1 ? '' : 's'} · ${l.conquered ? '<span class="cap">CAPTURED</span>' : '<span class="miss">held</span>'}</li>`);
    return [`<li>${who} <b>T${r.turnNumber}</b> +${r.reinforcements.total} troops${r.cardDrawn ? ' · drew a card' : ''}</li>`, ...lines];
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
    p.innerHTML = `<span class="sw"></span><div><b>${t.name}</b><br><small>${s.players[s.territories[id].owner].name} · ${c.name} +${c.bonus}</small></div><span class="tr">${projectedTroops()[id]}</span>`;
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
    const s = S();
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
    } else if (ui.phase === 'fortify') {
      if (!owns(id)) return void toast('Fortify between your own territories');
      if (ui.sel === null) {
        if (projectedTroops()[id] < 2) return void toast('Need at least 2 troops to move');
        ui.sel = id;
      } else if (id === ui.sel) ui.sel = null;
      else if (connectedOwned(map, s, me, ui.sel).has(id)) {
        ui.fortify = { fromTerritoryId: ui.sel, toTerritoryId: id, troops: projectedTroops()[ui.sel] - 1 };
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

  /** Steps through a turn's replay frames on the board, with the camera following each battle. */
  async function playReplay(before: GameState, outcome: TurnOutcome): Promise<void> {
    const frames = buildReplay(map, before, outcome.resolution);
    ui.phase = 'replay';
    ui.replayWho = outcome.resolution.playerIndex;
    ui.replayTurn = outcome.resolution.turnNumber;
    for (const f of frames) {
      if (ui.skip || !ui.alive) break;
      ui.frame = f;
      draw();
      if (f.focus?.length) camera.focusOn(f.focus.map(id => territoryPoint(map, id, ui.rotated)));
      await beat((BEAT_MS * f.weight) / ui.speed);
    }
    ui.frame = null;
    ui.skip = false;
    camera.fitAnimated();
  }

  async function commitTurn(): Promise<void> {
    const plan = buildPlan();
    const before = S();
    ui.phase = 'waiting';
    draw();
    let outcome: TurnOutcome;
    try {
      outcome = await game.submitTurnCommit(plan);
    } catch (err) {
      ui.phase = 'commit';
      draw();
      toast(err instanceof Error ? err.message : String(err));
      return;
    }
    resetPlan();
    opts.onChange?.(game);
    ui.sealing = true;
    draw();
    await sealOverlay(outcome);
    ui.sealing = false;
    ui.skip = false;
    await playReplay(before, outcome);
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
    if (s.phase === 'GAME_OVER' || s.players[me].eliminated) ui.phase = 'over';
    else if (game.isLocalTurn()) { resetPlan(); ui.phase = 'draft'; }
    draw();
  }

  function exit(): void {
    ui.alive = false;
    opts.onExit();
  }

  /* ------------------------------ wiring ------------------------------ */
  q('#open-drawer').onclick = () => q('#drawer').classList.add('open');
  q('#drawer').onclick = e => { if ((e.target as HTMLElement).id === 'drawer') q('#drawer').classList.remove('open'); };
  q('#exit').onclick = () => { if (confirm('Leave this game? (It is saved — you can continue from the menu.)')) exit(); };
  q('#fit').onclick = () => camera.fit();
  const autoSkip = q<HTMLInputElement>('#auto-skip');
  autoSkip.checked = ui.autoSkipBots;
  autoSkip.onchange = () => { ui.autoSkipBots = autoSkip.checked; localStorage.setItem('nd.autoSkipBots', autoSkip.checked ? '1' : '0'); };
  q('#phases').querySelectorAll<HTMLElement>('button').forEach(b => b.onclick = () => {
    const target = b.dataset.p as Phase;
    if (target !== 'draft' && (draftLeft() !== 0 || tradeRequired())) return toast('Place all your troops first');
    setPhase(target);
  });
  const resize = new ResizeObserver(() => draw());
  resize.observe(board);

  const s0 = S();
  if (s0.phase === 'SETUP_PLACEMENT' && !s0.players[me].setupDone) ui.phase = 'setup';
  else if (s0.phase === 'GAME_OVER' || s0.players[me].eliminated) ui.phase = 'over';
  else if (game.isLocalTurn()) ui.phase = 'draft';
  else { ui.phase = 'waiting'; void afterAction(); }
  draw(true);

  return () => { ui.alive = false; resize.disconnect(); offTurn(); root.innerHTML = ''; };
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
    <button data-p="commit">COMMIT</button>
  </nav>
  <section class="sheet glass" id="sheet"></section>
  <div class="drawer" id="drawer"><div class="drawer-panel glass">
    <h3>COMMANDERS</h3><ul id="roster"></ul>
    <h3>CONTINENTS</h3><ul id="continents"></ul>
    <h3>BATTLE LOG</h3><ul class="log" id="log"></ul>
    <h3>SETTINGS</h3><label class="setting"><input type="checkbox" id="auto-skip"> Auto-skip bot replays</label>
    <button class="btn exit" id="exit">◂ MENU</button>
  </div></div>
  <div class="overlay" id="overlay"></div>
</div>`;
