import type { LobbySession } from '../../nostr/lobbySession';
import { renderMap } from './hexMapRenderer';
import { MapCamera } from './mapCamera';
import { NEON } from '../theme';
import { commanderLabel } from '../../nostr/profile';
import '../styles/game.css';
import { commanderBadgesHtml, commanderRosterHtml, continentIntelHtml, deploymentPhaseHtml, escapeHtml, phaseIds, placementChipsHtml, territoryPillHtml } from './gamePhaseUi';

/** Initial placement board; never routes to LocalGame or starts bot turns. */
export function mountMultiplayerSetup(
  root: HTMLElement, getSession: () => LobbySession | null, run: (operation: () => Promise<void>) => Promise<void>, accountName?: string, onExit: () => void = () => {},
): { render(disabled: boolean, storageError?: string): void; destroy(): void } {
  root.innerHTML = `
    <div class="game mp-shell setup-shell">
      <header class="g-top"><button class="icon" id="ms-intel" aria-label="Intel">☰</button><div class="g-turn"><small>TURN</small><b>—</b></div><div class="g-players" id="ms-commanders"></div><button class="icon" id="ms-fit" aria-label="Fit map">⤢</button></header>
      <main class="board" id="ms-board"><svg id="ms-map" role="img" aria-label="Game map"></svg><div class="pill glass" id="ms-pill" hidden></div></main>
      <nav class="g-phases" hidden><button>DRAFT</button><button>ATTACK</button><button>FORTIFY</button><button>END TURN</button></nav>
      <section class="sheet glass mp-panel">
        <p id="ms-progress" role="status"></p><p id="ms-error" role="alert"></p><p id="ms-notice" role="status"></p><p id="ms-storage" role="status"></p>
        <button class="btn" id="ms-prepare" hidden>RETRY PREPARATION</button>
        <button class="btn" id="ms-retry" hidden>RETRY SENDING</button>
        <div class="phase-content" id="ms-content"></div>
      </section>
      <div class="drawer" id="ms-drawer"><div class="drawer-panel glass">
        <h3>COMMANDERS</h3><ul id="ms-players"></ul><h3>CONTINENTS</h3><ul id="ms-continents"></ul>
        <details class="log-wrap"><summary>SETUP DETAILS</summary><p id="ms-hash" class="setup-hash"></p><button class="btn" id="ms-rebroadcast">RESEND SAVED SETUP</button><p class="note">Keep this site's data to resume your game. A connected signing extension may ask for permission while the game prepares.</p></details>
        <div class="actions"><button class="btn" id="ms-menu">MENU</button><button class="btn" id="ms-close-intel">CLOSE</button></div>
      </div></div>
    </div>`;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const playerName = (pubkey: string, name: string) => commanderLabel(pubkey, name,
    accountName === undefined ? undefined : { pubkey: getSession()!.identity.pubkey, name: accountName });
  const svg = root.querySelector<SVGSVGElement>('#ms-map')!;
  const draft = new Map<number, number>();
  let step = 1;
  let baseHash: string | null = null;
  let blocked = true;
  let rotate = innerHeight > innerWidth * 1.1;
  let refit = false;
  let alive = true, preparing = false, preparationFailed = false;
  let prepareTimer: ReturnType<typeof setTimeout> | null = null;
  let pillTimer: ReturnType<typeof setTimeout> | null = null;
  const ownSeat = () => getSession()?.state.members.findIndex(m => m.pubkey === getSession()?.identity.pubkey) ?? -1;
  const editable = () => {
    const s = getSession();
    return !!s?.setup.base && ownSeat() >= 0 && !blocked && !s.setup.deployments.has(s.identity.pubkey);
  };
  const remaining = () => {
    const s = getSession(), seat = ownSeat();
    return (s?.setup.base && seat >= 0 ? s.setup.base.players[seat].setupTroops : 0) - [...draft.values()].reduce((a, b) => a + b, 0);
  };
  const camera = new MapCamera(q('#ms-board'), svg, target => {
    const id = Number(target.closest('[data-t]')?.getAttribute('data-t') ?? -1);
    const s = getSession(), state = s?.setup.state, map = s?.setup.map;
    if (!state || !map || !state.territories[id]) return;
    const territory = map.territories[id], continent = map.continents[territory.continentId], owner = state.territories[id].owner;
    const pill = q('#ms-pill');
    pill.style.setProperty('--pc', NEON.players[owner]);
    pill.innerHTML = territoryPillHtml(territory.name, playerName(state.players[owner].id, state.players[owner].name),
      continent.name, continent.bonus, state.territories[id].troops + (!s.setup.deployments.has(s.identity.pubkey) ? draft.get(id) ?? 0 : 0));
    pill.hidden = false;
    if (pillTimer) clearTimeout(pillTimer);
    pillTimer = setTimeout(() => { pill.hidden = true; }, 2500);
    if (!editable() || getSession()!.setup.base!.territories[id]?.owner !== ownSeat() || remaining() <= 0) return;
    draft.set(id, (draft.get(id) ?? 0) + Math.min(step, remaining()));
    draw();
  }, z => svg.classList.toggle('zoomed', z > 1.5));
  const draw = () => {
    const s = getSession();
    if (!s?.setup.base || !s.setup.map || !s.setup.state) return;
    const seat = ownSeat();
    const submitted = s.setup.deployments.has(s.identity.pubkey);
    const troops = s.setup.state.territories.map((t, id) => t.troops + (!submitted ? draft.get(id) ?? 0 : 0));
    const box = renderMap(svg, s.setup.map, {
      colorMode: 'owner', owners: s.setup.base.territories.map(t => t.owner), troops,
      rotate,
      myTerritories: new Set(s.setup.base.territories.flatMap((t, i) => t.owner === seat ? [i] : [])),
      boosted: new Set(submitted ? [] : draft.keys()),
    });
    camera.setFitBox(box, refit || baseHash !== s.setup.baseHash);
    refit = false;
    baseHash = s.setup.baseHash;
    q('#ms-hash').textContent = `Shared map/deal hash: ${s.setup.baseHash}`;
    q('#ms-content').innerHTML = seat < 0 ? '<div class="hint">You are not a commander in this game.</div>'
      : submitted ? `<div class="hint">Waiting for ${escapeHtml(s.setup.state.players.filter(p => !p.setupDone).map(p => playerName(p.id, p.name)).join(', ') || 'the first turn')}…</div>`
        : phaseIds(deploymentPhaseHtml(remaining(), step, placementChipsHtml(draft, id => s.setup.map!.territories[id].name)), 'ms-');
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-step]')) {
      button.disabled = !editable();
      button.onclick = () => { step = Number(button.dataset.step); draw(); };
    }
    const undo = root.querySelector<HTMLButtonElement>('#ms-undo'), deploy = root.querySelector<HTMLButtonElement>('#ms-deploy');
    if (undo) { undo.disabled = !editable(); undo.onclick = () => { draft.clear(); draw(); }; }
    if (deploy) {
      deploy.disabled = !editable() || remaining() !== 0;
      deploy.onclick = () => { void run(() => getSession()!.deploySetup([...draft].map(([territoryId, troops]) => ({ territoryId, troops })), localStorage)); };
    }
  };
  const schedule = () => {
    const s = getSession();
    if (!alive || blocked || preparing || prepareTimer || preparationFailed || !s?.state.start || ownSeat() < 0
      || s.setup.reveals.has(s.identity.pubkey) || s.setup.commits.has(s.identity.pubkey) && s.setup.commits.size < s.state.members.length) return;
    prepareTimer = setTimeout(() => {
      prepareTimer = null;
      if (!alive || blocked) return;
      preparing = true;
      void (async () => {
        try {
          if (!s.setup.commits.has(s.identity.pubkey)) await s.commitSeed(localStorage);
          else await s.revealSeed(localStorage);
        } catch (error) {
          preparationFailed = true;
          if (alive) {
            q('#ms-error').textContent = `Preparation paused: ${error instanceof Error ? error.message : String(error)}. Reconnect or retry after fixing the problem.`;
            q('#ms-prepare').hidden = false;
          }
        } finally { preparing = false; if (alive) schedule(); }
      })();
    }, 0);
  };
  q('#ms-prepare').onclick = () => { preparationFailed = false; q('#ms-error').textContent = ''; q('#ms-prepare').hidden = true; schedule(); };
  q('#ms-rebroadcast').onclick = () => { void run(() => getSession()!.rebroadcastSetup(localStorage)); };
  q('#ms-retry').onclick = () => { void run(() => getSession()!.retryPending(localStorage)); };
  q('#ms-menu').onclick = onExit;
  q('#ms-intel').onclick = () => { q('#ms-drawer').classList.add('open'); q('#ms-close-intel').focus(); };
  q('#ms-close-intel').onclick = () => { q('#ms-drawer').classList.remove('open'); q('#ms-intel').focus(); };
  q('#ms-drawer').onclick = event => { if (event.target === q('#ms-drawer')) q('#ms-close-intel').click(); };
  q('#ms-fit').onclick = () => camera.fit();
  const resize = () => {
    const next = innerHeight > innerWidth * 1.1;
    if (next === rotate) return;
    rotate = next;
    refit = true;
    draw();
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && q('#ms-drawer').classList.contains('open')) q('#ms-close-intel').click(); };
  window.addEventListener('resize', resize);
  window.addEventListener('keydown', onKey);
  return {
    destroy(): void { alive = false; if (prepareTimer) clearTimeout(prepareTimer); if (pillTimer) clearTimeout(pillTimer); window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey); },
    render(disabled: boolean, storageError = ''): void {
      const s = getSession();
      if (!s || !s.state.start) return;
      blocked = disabled || !!s.setup.conflict;
      q('#ms-storage').textContent = storageError;
      q('#ms-notice').textContent = s.notice;
      q('#ms-progress').textContent = s.setup.conflict ?? s.state.conflict ?? (s.setup.base
        ? ''
        : 'Preparing the battlefield. Waiting for all commanders to connect and get ready; you can return later.');
      const state = s.setup.state;
      if (state) {
        const label = (p: typeof state.players[number]) => playerName(p.id, p.name);
        q('#ms-players').innerHTML = commanderRosterHtml(state, ownSeat(), label);
        q('#ms-commanders').innerHTML = commanderBadgesHtml(state, -1, label);
        q('#ms-continents').innerHTML = s.setup.map ? continentIntelHtml(s.setup.map, state, label) : '';
      } else {
        q('#ms-players').textContent = s.state.members.map(m => playerName(m.pubkey, m.name)).join(', ');
      }
      q<HTMLButtonElement>('#ms-prepare').disabled = blocked;
      q<HTMLButtonElement>('#ms-rebroadcast').disabled = s.busy || !s.historyReady;
      q('#ms-retry').hidden = !s.pendingPublish;
      q<HTMLButtonElement>('#ms-retry').disabled = s.busy;
      schedule();
      if (s.setup.base && s.setup.baseHash !== baseHash) {
        draft.clear();
      }
      draw();
    },
  };
}
