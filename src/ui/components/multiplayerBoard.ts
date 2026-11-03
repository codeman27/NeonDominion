import '../styles/game.css';
import type { LobbySession } from '../../nostr/lobbySession';
import type { CardTradeOrder, FortifyOrder } from '../../types/actions';
import { bestSet, mustTrade } from '../../engine/rules';
import { computeReinforcements, tradeCards } from '../../engine/turnEngine';
import { connectedOwned } from '../../engine/fortify';
import { renderMap, type MapArrow } from './hexMapRenderer';
import { MapCamera } from './mapCamera';
import { battleResultsHtml } from './battleResults';
import { NEON } from '../theme';
import { beaconTime, fetchBeacon } from '../../nostr/beacon';
import { commanderLabel } from '../../nostr/profile';
import { attackConfirmationHtml, commanderBadgesHtml, commanderRosterHtml, continentIntelHtml, draftPhaseHtml, escapeHtml, fortifyPhaseHtml, gameOverPhaseHtml, movementPhaseHtml, phaseIds, placementChipsHtml, territoryPillHtml } from './gamePhaseUi';
import { showGameSummary } from './eventInspector';

export function mountMultiplayerBoard(
  root: HTMLElement, getSession: () => LobbySession | null, run: (operation: () => Promise<void>) => Promise<void>,
  onExit: () => void, accountName?: string,
): { render(disabled: boolean, storageError?: string): void; destroy(): void } {
  root.innerHTML = `
    <div class="game mp-shell">
      <header class="g-top">
        <button class="icon" id="mp-intel" aria-label="Intel">☰</button>
        <div class="g-turn"><small>TURN</small><b id="mp-round">—</b></div>
        <div class="g-players" id="mp-commanders"></div>
        <button class="icon" id="mp-fit" aria-label="Fit map">⤢</button>
      </header>
      <main class="board" id="mp-board"><svg id="mp-map" role="img" aria-label="Game map"></svg>
        <div class="pill glass" id="mp-pill" hidden></div>
      </main>
      <nav class="g-phases" id="mp-phases" aria-label="Turn phases">
        <button data-phase="draft">DRAFT<i id="mp-draft-badge"></i></button><button data-phase="attack">ATTACK</button><button data-phase="fortify">FORTIFY</button><button data-phase="end">END TURN</button>
      </nav>
      <section class="sheet glass mp-panel">
        <p id="mp-status" role="status" aria-live="polite"></p><p id="mp-error" role="alert"></p><p id="mp-notice" role="status"></p><p id="mp-storage" role="status"></p>
        <div class="actions" id="mp-recovery" hidden><button class="btn" id="mp-retry" hidden>RETRY SENDING</button><button class="btn" id="mp-service" hidden>RETRY PREPARATION</button></div>
        <div class="phase-content" id="mp-content"></div>
      </section>
      <div class="drawer" id="mp-drawer"><div class="drawer-panel glass">
        <h3>COMMANDERS</h3><ul id="mp-players"></ul><h3>CONTINENTS</h3><ul id="mp-continents"></ul>
        <details class="log-wrap"><summary>BATTLE LOG</summary><div id="mp-battle-list"></div></details>
        <details class="log-wrap"><summary>CONNECTION DETAILS</summary>
          <p id="mp-connection"></p><p id="mp-state-hash" class="setup-hash"></p>
          <button class="btn" id="mp-refresh">RECONNECT</button><button class="btn" id="mp-export">DOWNLOAD GAME HISTORY</button>
          <p class="note">Play with people you trust. Modified clients can manipulate unpublished dice. Keep site data and use one tab per account.</p>
        </details>
        <div class="actions"><button class="btn" id="mp-back">MENU</button><button class="btn" id="mp-close-intel">CLOSE</button></div>
      </div></div>
    </div>`;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const content = q('#mp-content');
  const playerName = (player: { id: string; name: string }) => commanderLabel(player.id, player.name,
    accountName === undefined ? undefined : { pubkey: getSession()!.identity.pubkey, name: accountName });
  const svg = root.querySelector<SVGSVGElement>('#mp-map')!;
  let blocked = true, alive = true, key = '', source = -1, target = -1, fortifying = false;
  let trades: CardTradeOrder[] = [], fortify: FortifyOrder | null = null, fSource = -1, moveTroops = 1, step = 1;
  let stopAt: number | null = null, resultsOpen = false;
  const draft = new Map<number, number>();
  let rotate = innerHeight > innerWidth * 1.1, refit = true, watching = false;
  let serviceTimer: ReturnType<typeof setTimeout> | null = null;
  let serviceBusy = false, serviceFailed = false, recoveredIndex = '';
  const serviceAbort = new AbortController();
  let pillTimer: ReturnType<typeof setTimeout> | null = null;
  const me = () => getSession()?.state.members.findIndex(m => m.pubkey === getSession()?.identity.pubkey) ?? -1;
  const pendingRound = () => {
    const play = getSession()?.play;
    return play?.beaconLock?.payload.type === 'play-beacon-lock' ? play.beaconLock.payload.round
      : play?.pending?.payload.type === 'play-action' ? play.pending.payload.beaconRound : undefined;
  };
  const isDraft = () => {
    const snap = getSession()?.play.snapshot;
    return !!snap && (snap.phase === 'draft' || snap.phase === 'attack' && mustTrade(snap.state.players[snap.state.activePlayerIndex].cards.length));
  };
  const reinforcements = () => {
    const session = getSession()!, snap = session.play.snapshot!, seat = snap.state.activePlayerIndex;
    const plan = { type: 'TURN_ACTION_PLAN' as const, turnNumber: snap.state.turnNumber, playerIndex: seat, cardTrades: trades, draftPlacements: [], attackQueue: [], fortify: null };
    const result = tradeCards(snap.state, plan), r = computeReinforcements(session.setup.map!, snap.state, seat, result.trades);
    return { ...r, errors: result.errors, amount: snap.phase === 'draft' ? r.total : r.cardTradeBonus };
  };
  const left = () => reinforcements().amount - [...draft.values()].reduce((a, b) => a + b, 0);
  const act = (operation: () => Promise<void>) => { if (!blocked) void run(operation); };
  const camera = new MapCamera(q('#mp-board'), svg, el => {
    const session = getSession(), snap = session?.play.snapshot, map = session?.setup.map;
    const id = Number(el.closest('[data-t]')?.getAttribute('data-t') ?? -1);
    if (!snap || !map || !snap.state.territories[id]) return;
    const territory = map.territories[id], continent = map.continents[territory.continentId], owner = snap.state.territories[id].owner;
    const pill = q('#mp-pill');
    pill.style.setProperty('--pc', NEON.players[owner]);
    pill.innerHTML = territoryPillHtml(territory.name, playerName(snap.state.players[owner]), continent.name, continent.bonus,
      snap.state.territories[id].troops + (isDraft() && snap.state.activePlayerIndex === me() ? (draft.get(id) ?? 0) + (reinforcements().matchTerritories.includes(id) ? 2 : 0) : 0));
    pill.hidden = false;
    if (pillTimer) clearTimeout(pillTimer);
    pillTimer = setTimeout(() => { pill.hidden = true; }, 2500);
    if (blocked || snap.state.activePlayerIndex !== me()) return;
    if (isDraft()) {
      if (snap.state.territories[id].owner !== me() || left() <= 0) return;
      draft.set(id, (draft.get(id) ?? 0) + Math.min(step, left()));
    } else if (snap.phase === 'attack' && fortifying) {
      if (snap.state.territories[id].owner !== me()) return;
      if (fSource < 0 || fSource === id || !connectedOwned(map, snap.state, me(), fSource).has(id)) {
        if (snap.state.territories[id].troops <= 1) return;
        fSource = id; fortify = null;
      } else {
        fortify = { fromTerritoryId: fSource, toTerritoryId: id, troops: 1 };
      }
    } else if (snap.phase === 'attack') {
      if (snap.state.territories[id].owner === me()) { source = snap.state.territories[id].troops > 1 ? id : -1; target = -1; }
      else if (source >= 0 && map.territories[source].neighbors.includes(id)) target = id;
    }
    draw();
  }, z => svg.classList.toggle('zoomed', z > 1.5));

  function draw(): void {
    const session = getSession(), snap = session?.play.snapshot, map = session?.setup.map;
    if (!session || !snap || !map) return;
    const own = me(), active = snap.state.activePlayerIndex, mine = own === active, drafting = isDraft();
    const tn = (id: number) => map.territories[id].name;
    const r = drafting ? reinforcements() : null;
    const troops = snap.state.territories.map((t, id) => t.troops + (mine && drafting ? (draft.get(id) ?? 0) + (r?.matchTerritories.includes(id) ? 2 : 0) : 0));
    const selected = drafting ? null : fortifying ? fSource : source;
    const highlight = selected !== null && selected >= 0 && snap.phase === 'attack' && !drafting
      ? fortifying ? connectedOwned(map, snap.state, active, selected)
        : new Set(map.territories[selected].neighbors.filter(id => snap.state.territories[id].owner !== active)) : null;
    const arrows: MapArrow[] = snap.move ? [{ from: snap.move.from, to: snap.move.to, kind: 'attack', label: 'M' }]
      : fortifying && fortify ? [{ from: fortify.fromTerritoryId, to: fortify.toTerritoryId, kind: 'fortify', label: 'F' }]
        : source >= 0 && target >= 0 ? [{ from: source, to: target, kind: 'attack', label: '!' }] : [];
    camera.setFitBox(renderMap(svg, map, {
      colorMode: 'owner', owners: snap.state.territories.map(t => t.owner), troops, rotate,
      selected: selected !== null && selected >= 0 ? selected : null, highlight,
      boosted: new Set(draft.keys()), arrows,
      myTerritories: mine && (drafting || snap.phase === 'attack' && source < 0 && !fortifying)
        ? new Set(snap.state.territories.flatMap((t, i) => t.owner === own && (drafting || t.troops >= 2) ? [i] : [])) : null,
    }), refit);
    refit = false;
    q('#mp-round').textContent = String(snap.round).padStart(2, '0');
    q('#mp-commanders').innerHTML = commanderBadgesHtml(snap.state, snap.phase === 'over' ? -1 : active, playerName);
    q('#mp-players').innerHTML = commanderRosterHtml(snap.state, own, playerName);
    q('#mp-continents').innerHTML = continentIntelHtml(map, snap.state, playerName);
    q('#mp-phases').hidden = !mine || snap.phase !== 'draft';
    q('#mp-draft-badge').textContent = drafting && left() ? String(left()) : '';
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-phase]')) {
      button.classList.toggle('active', button.dataset.phase === (drafting ? 'draft' : fortifying ? 'fortify' : 'attack'));
      button.disabled = blocked || !mine || snap.phase !== 'attack' || drafting;
    }
    q('#mp-status').textContent = session.play.conflict ? `GAME HALTED: ${session.play.conflict}`
      : session.publishingTurn ? 'Your turn has not finished sending. Retry to continue; your dice will not change.'
        : session.pendingPublish ? 'Your move has not finished sending. Retry to continue; your dice will not change.'
        : session.hasLocalTurn && !session.historyReady ? 'Playing offline. Your turn is saved on this device and will send at Finish Turn.'
        : !session.historyReady ? 'Catching up on the game...'
          : session.play.pending ? 'Finishing your saved attack. Please wait; your dice will not change.' : '';
    q('#mp-notice').textContent = session.notice;
    q('#mp-connection').textContent = `${session.status} ${session.notice}`;
    q('#mp-state-hash').textContent = `Action ${session.play.index} · State ${session.play.hash}`;
    q('#mp-retry').hidden = !session.pendingPublish && !session.publishingTurn;
    q('#mp-service').hidden = !serviceFailed;
    q('#mp-recovery').hidden = !session.pendingPublish && !session.publishingTurn && !serviceFailed;
    q<HTMLButtonElement>('#mp-retry').disabled = session.busy;
    q<HTMLButtonElement>('#mp-refresh').disabled = session.busy;
    const battle = session.play.lastBattle;
    const results = battle ? battleResultsHtml(battle, tn, resultsOpen) : '';
    const eliminated = own >= 0 && snap.state.players[own].eliminated;
    let html: string;
    if (snap.phase === 'over' || eliminated && !watching) {
      html = gameOverPhaseHtml(snap.state.winnerIndex === own, snap.phase === 'over' ? playerName(snap.state.players[snap.state.winnerIndex!]) : null, snap.round, snap.state.players.length);
    } else if (!mine) {
      html = `<div class="hint"><b style="color:${NEON.players[active]}">${escapeHtml(playerName(snap.state.players[active]))}</b> is moving…</div>`;
    } else if (drafting && r) {
      const used = new Set(trades.flatMap(t => t.cardIds)), cards = snap.state.players[active].cards;
      const parts = [snap.phase === 'draft' ? `${r.base} base` : '', snap.phase === 'draft' && r.continentBonus ? `${r.continentBonus} continents` : '', r.cardTradeBonus ? `${r.cardTradeBonus} cards` : ''].filter(Boolean).join(' + ');
      html = draftPhaseHtml({ left: left(), step, parts: parts + (r.matchTerritories.length ? ` · +2 on ${r.matchTerritories.map(tn).join(', ')}` : ''), cards, traded: used,
        required: mustTrade(cards.length - used.size), chips: placementChipsHtml(draft, tn), territoryName: tn });
    } else if (snap.phase === 'move' && snap.move) {
      const m = snap.move, max = snap.state.territories[m.from].troops - 1;
      moveTroops = Math.max(m.min, Math.min(max, moveTroops));
      html = movementPhaseHtml(moveTroops, m.min, max, `${tn(m.from)} → ${tn(m.to)}`, results);
    } else if (fortifying) {
      html = fortifyPhaseHtml({ interactive: true, hint: fSource < 0 ? 'Optional: tap a source, then any connected territory of yours. Then END TURN.' : `From ${tn(fSource)}: tap a pulsing destination`,
        move: fortify ? { from: tn(fortify.fromTerritoryId), to: tn(fortify.toTerritoryId), troops: fortify.troops } : undefined });
    } else if (source >= 0 && target >= 0) {
      const attackers = snap.state.territories[source].troops - 1, maxStop = Math.max(1, attackers - 1);
      if (stopAt !== null) stopAt = Math.min(maxStop, stopAt);
      html = attackConfirmationHtml(attackers, attackers, `${tn(source)} → ${tn(target)}`, attackers > 1 ? stopAt : null);
    } else {
      html = `<div class="summary"><div><b>0</b><small>REMAINING</small></div></div><div class="rp-cap">${source < 0 ? 'TAP YOUR TERRITORY' : 'Tap adjacent enemy to attack'}</div>
        <div class="actions"><div class="hint-text">Tap your territory, then tap an adjacent enemy to attack</div></div>
        <div class="actions"><button class="btn" id="fortify-now">FORTIFY ▸▸</button></div>${results}`;
    }
    const openCards = content.querySelector<HTMLDetailsElement>('.cards-help')?.open ?? false;
    const scroll = q('.sheet').scrollTop;
    content.innerHTML = phaseIds(html, 'mp-');
    const help = content.querySelector<HTMLDetailsElement>('.cards-help');
    if (help) help.open = openCards;
    q('.sheet').scrollTop = scroll;
    bindPhase();
    if (blocked) for (const control of content.querySelectorAll<HTMLInputElement | HTMLButtonElement>('button, input')) {
      if (!['mp-menu', 'mp-stats', 'mp-watch'].includes(control.id)) control.disabled = true;
    }
    q('#mp-battle-list').innerHTML = session.play.battles.slice(-20).reverse().map(b => phaseIds(battleResultsHtml(b, tn, false), `log-${b.orderId}-`)).join('');
  }

  function bindPhase(): void {
    const session = getSession()!, snap = session.play.snapshot!, map = session.setup.map!;
    const on = (id: string, handler: () => void) => { const button = content.querySelector<HTMLButtonElement>(`#mp-${id}`); if (button) button.onclick = handler; };
    for (const button of content.querySelectorAll<HTMLButtonElement>('[data-step]')) button.onclick = () => { step = Number(button.dataset.step); draw(); };
    on('undo', () => { trades = []; draft.clear(); draw(); });
    on('trade', () => {
      const used = new Set(trades.flatMap(t => t.cardIds)), set = bestSet(snap.state.players[snap.state.activePlayerIndex].cards.filter(c => !used.has(c.id)));
      if (set) { trades.push({ cardIds: set.cardIds }); draw(); }
    });
    on('start-atk', () => act(() => session.submitPlay({ kind: snap.phase === 'draft' ? 'draft' : 'trade', trades, placements: [...draft].map(([territoryId, troops]) => ({ territoryId, troops })) }, localStorage)));
    const results = content.querySelector<HTMLDetailsElement>('#mp-battle-results');
    if (results) results.ontoggle = () => { if (results.isConnected) resultsOpen = results.open; };
    on('atk-cancel', () => { source = -1; target = -1; draw(); });
    on('atk-confirm', () => act(() => session.submitPlay({ kind: 'attack', from: source, to: target, dice: 3,
      stop: stopAt === null || snap.state.territories[source].troops <= 2 ? 0 : stopAt + 1 }, localStorage)));
    const stopInput = content.querySelector<HTMLInputElement>('#mp-atk-stop-input');
    if (stopInput) {
      const readStop = () => Math.max(1, Math.min(Number(stopInput.max), Math.floor(Number(stopInput.value)) || 1));
      const setStop = (value: number | null) => {
        stopAt = value;
        if (value !== null) stopInput.value = String(value);
        q('#mp-atk-stop-toggle').setAttribute('aria-pressed', String(value !== null));
        q<HTMLButtonElement>('#mp-atk-stop-off').disabled = value === null;
      };
      on('atk-stop-toggle', () => setStop(readStop())); on('atk-stop-off', () => setStop(null));
      on('atk-stop-minus', () => setStop(Math.max(1, (stopAt ?? readStop()) - 1)));
      on('atk-stop-plus', () => setStop(Math.min(Number(stopInput.max), (stopAt ?? readStop()) + 1)));
      stopInput.oninput = () => { if (Number.isInteger(stopInput.valueAsNumber) && stopInput.valueAsNumber >= 1 && stopInput.valueAsNumber <= Number(stopInput.max)) setStop(stopInput.valueAsNumber); };
      stopInput.onchange = () => setStop(readStop());
    }
    if (snap.move) {
      const min = snap.move.min, max = snap.state.territories[snap.move.from].troops - 1;
      const setMove = (value: number) => { moveTroops = Math.max(min, Math.min(max, value)); draw(); };
      const input = content.querySelector<HTMLInputElement>('#mp-move-input');
      if (input) {
        input.oninput = () => { moveTroops = Math.max(min, Math.min(max, Math.floor(Number(input.value)) || min)); q('#mp-content .big .n').textContent = String(moveTroops); };
        input.onchange = () => setMove(moveTroops);
        on('move-set', () => setMove(moveTroops));
      }
      on('move-minus', () => setMove(moveTroops - 1)); on('move-plus', () => setMove(moveTroops + 1));
      on('move-min', () => setMove(min)); on('move-max', () => setMove(max));
      on('move-confirm', () => act(() => session.submitPlay({ kind: 'move', troops: moveTroops }, localStorage)));
    }
    on('fortify-now', () => { fortifying = true; source = -1; target = -1; draw(); });
    on('fortify-back', () => { fortifying = false; fSource = -1; fortify = null; draw(); });
    on('f-clear', () => { fortify = null; fSource = -1; draw(); });
    on('f-m', () => { if (fortify) fortify.troops = Math.max(1, fortify.troops - 1); draw(); });
    on('f-p', () => { if (fortify) fortify.troops = Math.min(snap.state.territories[fortify.fromTerritoryId].troops - 1, fortify.troops + 1); draw(); });
    on('f-max', () => { if (fortify) fortify.troops = snap.state.territories[fortify.fromTerritoryId].troops - 1; draw(); });
    on('fortify-finish', () => act(() => session.submitPlay({ kind: 'end', fortify }, localStorage)));
    on('menu', onExit);
    on('watch', () => { watching = true; draw(); });
    on('stats', () => showGameSummary(root, {
      won: snap.state.winnerIndex === me(), winnerName: playerName(snap.state.players[snap.state.winnerIndex!]), winner: snap.state.winnerIndex!,
      round: snap.round, territories: map.territories.length, players: snap.state.players.map((p, i) => ({
        name: playerName(p), captures: snap.stats[i].captures, troopsKilled: snap.stats[i].kills, troopsLost: snap.stats[i].losses,
        peakTerritories: snap.stats[i].peak, eliminatedRound: snap.stats[i].out,
      })),
    }, { onMenu: onExit, onLog: () => { q('#mp-drawer').classList.add('open'); q('#mp-battle-list').closest('details')!.open = true; } }));
  }

  async function service(): Promise<void> {
    serviceTimer = null;
    const session = getSession();
    if (!alive || !session || serviceBusy || serviceFailed || session.busy || session.pendingPublish || session.publishingTurn || !session.historyReady
      || session.state.conflict || session.setup.conflict || session.play.conflict || me() < 0 || !session.setup.state?.players.every(p => p.setupDone)) return;
    serviceBusy = true;
    try {
      if (session.play.pending && (session.play.snapshot?.randomness || session.play.beaconLock)) {
        await session.resolveBeacon(localStorage, round => fetchBeacon(round, serviceAbort.signal));
      } else if (session.play.snapshot?.randomness !== 'nostr-dice-v1') {
        await session.prepareNostrPlay(localStorage);
      } else if (session.play.snapshot && session.play.snapshot.state.players[session.play.snapshot.state.activePlayerIndex].id === session.identity.pubkey) {
        recoveredIndex = `${session.play.prev}:${session.play.index}`;
        await session.resumePlay(localStorage);
      }
    } catch (error) {
      serviceFailed = true;
      if (alive) { q('#mp-error').textContent = `Preparation paused: ${error instanceof Error ? error.message : String(error)}. Retry to continue; your attack will not change.`; draw(); }
    } finally { serviceBusy = false; if (alive) schedule(); }
  }
  function schedule(): void {
    const s = getSession();
    if (!alive || serviceTimer || serviceBusy || serviceFailed || !s || s.busy || s.pendingPublish || s.publishingTurn || !s.historyReady
      || s.play.conflict || s.setup.conflict || s.state.conflict || me() < 0 || !s.setup.state?.players.every(p => p.setupDone)) return;
    const snapshot = s.play.snapshot;
    const active = snapshot ? snapshot.state.players[snapshot.state.activePlayerIndex].id === s.identity.pubkey : s.invite.host === s.identity.pubkey;
    if (snapshot?.phase === 'over') return;
    if (snapshot?.randomness !== 'nostr-dice-v1' && !s.play.pending && !active) return;
    if (!snapshot?.randomness && !s.play.beaconLock && !active) return;
    const recover = snapshot && active && recoveredIndex !== `${s.play.prev}:${s.play.index}`;
    if (snapshot?.randomness === 'nostr-dice-v1' && !s.play.pending && !recover) return;
    const round = pendingRound();
    serviceTimer = setTimeout(() => { void service(); }, round ? Math.min(2147483647, Math.max(100, beaconTime(round) * 1000 - Date.now() + 300)) : 0);
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-phase]')) button.onclick = () => {
    if (blocked || isDraft()) return;
    fortifying = button.dataset.phase === 'fortify' || button.dataset.phase === 'end'; draw();
  };
  q('#mp-fit').onclick = () => camera.fit();
  q('#mp-intel').onclick = () => { q('#mp-drawer').classList.add('open'); q('#mp-close-intel').focus(); };
  q('#mp-close-intel').onclick = () => { q('#mp-drawer').classList.remove('open'); q('#mp-intel').focus(); };
  q('#mp-drawer').onclick = event => { if (event.target === q('#mp-drawer')) q('#mp-close-intel').click(); };
  q('#mp-back').onclick = onExit;
  q('#mp-refresh').onclick = () => { serviceFailed = false; getSession()?.start(); schedule(); };
  q('#mp-retry').onclick = () => { void run(() => getSession()!.retryPending(localStorage)); };
  q('#mp-service').onclick = () => { serviceFailed = false; q('#mp-error').textContent = ''; schedule(); draw(); };
  q('#mp-export').onclick = () => {
    const session = getSession()!;
    const url = URL.createObjectURL(new Blob([JSON.stringify([...session.records.values()].map(r => r.event), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `neon-dominion-game-${session.invite.id.slice(0, 8)}.json`; link.click(); URL.revokeObjectURL(url);
  };
  const resize = () => { const next = innerHeight > innerWidth * 1.1; if (next !== rotate) { rotate = next; refit = true; draw(); } };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && q('#mp-drawer').classList.contains('open')) q('#mp-close-intel').click(); };
  window.addEventListener('resize', resize); window.addEventListener('keydown', onKey);
  return {
    destroy(): void { alive = false; serviceAbort.abort(); if (serviceTimer) clearTimeout(serviceTimer); if (pillTimer) clearTimeout(pillTimer); window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey); },
    render(disabled: boolean, storageError = ''): void {
      q('#mp-storage').textContent = storageError;
      const session = getSession(), snap = session?.play.snapshot;
      blocked = disabled || !!session?.play.pending || !!session?.play.conflict || !!session?.publishingTurn;
      if (snap && session) {
        const nextKey = `${session.play.index}:${snap.phase}`;
        if (nextKey !== key) {
          key = nextKey; trades = []; draft.clear(); fortifying = false; source = -1; target = -1; fSource = -1; fortify = null;
          if (snap.move) moveTroops = snap.move.min;
        }
        draw();
      } else {
        q('#mp-status').textContent = session?.play.conflict ?? 'Getting your game ready. You can return later if the first commander is offline.';
        q('#mp-notice').textContent = session?.notice ?? '';
        q('#mp-retry').hidden = !session?.pendingPublish && !session?.publishingTurn; q('#mp-service').hidden = !serviceFailed;
        q('#mp-recovery').hidden = !session?.pendingPublish && !session?.publishingTurn && !serviceFailed;
        q('#mp-phases').hidden = true; content.replaceChildren();
      }
      schedule();
    },
  };
}
