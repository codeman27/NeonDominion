import { computeGameStats } from '../../transport/gameStats';
import type { LocalGame } from '../../transport/localTransport';
import { NEON } from '../theme';

const PAGE = 120;

function modal(host: HTMLElement, html: string): HTMLElement {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="modal-panel glass">${html}</div>`;
  host.appendChild(m);
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
  return m;
}

const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/**
 * Raw text event log (step 1.18): every commit, reveal and setup event exactly as it would travel over
 * Nostr, plus a VERIFY button that rebuilds the whole game from the text alone.
 */
export function openEventInspector(host: HTMLElement, game: LocalGame): void {
  const events = [...game.getEvents()].reverse();
  const names = new Map(game.getState().players.map((p, i) => [p.id, { name: p.name, color: NEON.players[i] }]));
  let shown = PAGE;
  const m = modal(host, `
    <div class="modal-head"><b>EVENT LOG</b><small>${events.length} events · all text</small><button class="x" data-close aria-label="Close">✕</button></div>
    <div class="modal-actions"><button class="btn" id="ev-copy">COPY JSON</button><button class="btn primary" id="ev-verify">VERIFY ✓</button></div>
    <div class="ev-result" id="ev-result"></div>
    <ul class="ev-list" id="ev-list"></ul>`);
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => m.querySelector(sel) as T;

  const render = () => {
    q('#ev-list').innerHTML = events.slice(0, shown).map(e => {
      const who = names.get(e.author);
      const p = e.payload;
      const extra = p.kind === 'TURN_COMMIT' ? ` · T${p.turnNumber} plan` : p.kind === 'TURN_REVEAL' ? ` · T${p.turnNumber} secret ${p.revealedSecret.slice(0, 8)}…` : '';
      return `<li><details><summary><span class="seq">#${e.seq}</span> <span class="kind">${p.kind}</span> <span style="color:${who?.color ?? 'var(--dim)'}">${who?.name ?? e.author}</span>${extra} <code>${e.id.slice(0, 8)}</code></summary>
        <pre>${esc(JSON.stringify(e, null, 2))}</pre></details></li>`;
    }).join('') + (shown < events.length ? `<li><button class="btn" id="ev-more">SHOW ${Math.min(PAGE, events.length - shown)} MORE</button></li>` : '');
    const more = m.querySelector<HTMLButtonElement>('#ev-more');
    if (more) more.onclick = () => { shown += PAGE; render(); };
  };
  render();

  q('[data-close]').onclick = () => m.remove();
  q('#ev-copy').onclick = async () => {
    await navigator.clipboard?.writeText(game.exportEventLog()).catch(() => undefined);
    q('#ev-copy').textContent = 'COPIED ✓';
  };
  q('#ev-verify').onclick = () => {
    const out = q('#ev-result');
    try {
      const t0 = performance.now();
      const stats = computeGameStats(game.exportEventLog());
      out.className = 'ev-result ok';
      out.innerHTML = `✓ Rebuilt ${events.length} events from text in ${Math.round(performance.now() - t0)} ms. Every reveal matched its hash chain and every state hash matched.<br><code>final state ${stats.finalStateHash.slice(0, 24)}…</code>`;
    } catch (err) {
      out.className = 'ev-result bad';
      out.textContent = `✕ ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}

/** End-of-game screen with per-commander stats derived from the event log. */
export function showVictory(host: HTMLElement, game: LocalGame, actions: { onMenu(): void; onLog(): void }): void {
  const s = game.getState();
  const me = game.localPlayerIndex;
  const stats = computeGameStats(game.exportEventLog());
  const won = s.winnerIndex === me;
  const winner = s.winnerIndex ?? 0;
  const rows = s.players.map((p, i) => {
    const st = stats.players[i];
    return `<tr style="--pc:${NEON.players[i]}"><td><span class="sw"></span>${p.name}${i === winner ? ' ★' : ''}</td><td>${st.captures}</td><td>${st.troopsKilled}</td><td>${st.troopsLost}</td><td>${st.peakTerritories}</td></tr>`;
  }).join('');
  const m = modal(host, `
    <div class="victory ${won ? 'won' : 'lost'}" style="--pc:${NEON.players[winner]}">
      <div class="v-kicker">${won ? 'DOMINION ACHIEVED' : 'GAME OVER'}</div>
      <h2>${won ? 'VICTORY' : `${s.players[winner].name} WINS`}</h2>
      <p>${stats.turns} turns · ${s.players.length} commanders · ${game.map.territories.length} territories</p>
    </div>
    <table class="v-stats"><thead><tr><th></th><th>CAPT</th><th>KILLS</th><th>LOST</th><th>PEAK</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="modal-actions"><button class="btn" id="v-log">EVENT LOG</button><button class="btn primary" id="v-menu">MENU</button></div>`);
  (m.querySelector('#v-log') as HTMLButtonElement).onclick = () => { m.remove(); actions.onLog(); };
  (m.querySelector('#v-menu') as HTMLButtonElement).onclick = () => { m.remove(); actions.onMenu(); };
}
