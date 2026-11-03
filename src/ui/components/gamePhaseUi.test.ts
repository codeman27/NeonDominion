import { describe, expect, it } from 'vitest';
import { attackConfirmationHtml, commanderBadgesHtml, commanderRosterHtml, continentIntelHtml, deploymentPhaseHtml, draftPhaseHtml, fortifyPhaseHtml, gameOverPhaseHtml, movementPhaseHtml, phaseIds, placementChipsHtml, territoryPillHtml } from './gamePhaseUi';
import type { TerritoryCard } from '../../types/game';
import { startedGame } from '../../engine/testing';

describe('shared solo and multiplayer phase presentation', () => {
  const tn = (id: number) => `Territory ${id}`;
  it('uses the same deployment sheet with step controls, chips, undo and deploy', () => {
    const chips = placementChipsHtml(new Map([[0, 5], [1, 0]]), tn);
    const html = deploymentPhaseHtml(7, 5, chips);
    expect(html).toContain('STARTING TROOPS');
    expect(html).toContain('data-step="5" class="on"');
    expect(html).toContain('Territory 0<b>+5</b>');
    expect(chips).not.toContain('Territory 1');
    expect(html).toContain('id="deploy" disabled');
    expect(deploymentPhaseHtml(0, 1, chips)).not.toContain('id="deploy" disabled');
  });
  it('renders actual card tiles, traded cards and mandatory trade gating', () => {
    const cards: TerritoryCard[] = Array.from({ length: 5 }, (_, id) => ({ id, territoryId: id, emblem: 'INFANTRY' }));
    const html = draftPhaseHtml({ left: 0, step: 1, parts: '3 base', cards, traded: new Set([0]), required: true,
      chips: placementChipsHtml(new Map(), tn), territoryName: tn });
    expect(html).toContain('class="card INFANTRY traded"');
    expect(html).toContain('TRADE +');
    expect(html).toContain('5+ cards: you must trade');
    expect(html).toContain('id="start-atk" disabled');
    expect(html).not.toContain('No cards yet.');
  });
  it('renders bounded conquest movement and the same min/max/step buttons', () => {
    const html = movementPhaseHtml(3, 3, 12, 'A → B', '<details>Results</details>');
    expect(html).toContain('value="3" min="3" max="12"');
    for (const id of ['move-minus', 'move-plus', 'move-set', 'move-min', 'move-max', 'move-confirm']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('TROOPS TO MOVE');
    expect(html).toContain('<details>Results</details>');
  });
  it('shares attack stop controls including the one-attacker restriction', () => {
    const active = attackConfirmationHtml(14, 14, 'A → B', 13);
    expect(active).toContain('aria-pressed="true"');
    expect(active).toContain('value="13" min="1" max="13"');
    expect(attackConfirmationHtml(1, 1, 'A → B', null)).toContain('class="stop-palette" disabled');
  });
  it('shares the tapped-territory pill and escapes commander names', () => {
    const html = territoryPillHtml('A&B', '<Commander>', 'C', 3, 14);
    expect(html).toContain('<b>A&amp;B</b>');
    expect(html).toContain('&lt;Commander&gt; · C +3');
    expect(html).toContain('<span class="tr">14</span>');
  });
  it('keeps HUD and intel layout identical when commander labels replace bot names', () => {
    const { state, map } = startedGame(2, 'shared-hud');
    const names = new Map(state.players.map((p, i) => [p.id, `Commander ${i}`]));
    const name = (p: typeof state.players[number]) => names.get(p.id)!;
    for (const render of [
      () => commanderBadgesHtml(state, state.activePlayerIndex, name),
      () => commanderRosterHtml(state, 0, name),
      () => continentIntelHtml(map, state, name),
    ]) {
      const before = JSON.stringify(state), html = render();
      expect(html).toContain('Commander');
      expect(html).not.toContain('Bot');
      expect(JSON.stringify(state)).toBe(before);
    }
    expect(commanderRosterHtml(state, 0, name)).toContain('<em>TRP</em>');
  });
  it('keeps fortification optional, with a compact stepper and finish-turn confirmation', () => {
    const empty = fortifyPhaseHtml({ hint: 'Select source', interactive: true });
    expect(empty).toContain('Optional fortify move.');
    expect(empty).toContain('FINISH TURN');
    expect(empty).not.toContain('id="f-clear"');
    expect(empty).not.toContain('id="f-max"');
    const move = fortifyPhaseHtml({ hint: 'Select destination', interactive: true, move: { from: 'A', to: 'B', troops: 4 } });
    expect(move).toContain('class="fort"');
    expect(move).toContain('<b>4</b>');
    expect(move).toContain('id="f-clear"');
    expect(move).toContain('<button id="f-max">MAX</button>');
    expect(phaseIds(move, 'mp-')).toContain('<button id="mp-f-max">MAX</button>');
  });
  it('shares victory/elimination actions and escapes commander/territory labels', () => {
    expect(gameOverPhaseHtml(true, 'Winner', 3, 2)).toContain('VICTORY');
    expect(gameOverPhaseHtml(false, null, 3, 2)).toContain('YOU WERE ELIMINATED');
    expect(gameOverPhaseHtml(false, '<Commander>', 3, 2)).toContain('&lt;Commander&gt; WINS');
    expect(placementChipsHtml(new Map([[0, 1]]), () => '<img onerror="bad">')).not.toContain('<img');
    expect(movementPhaseHtml(1, 1, 3, '<A> → B')).toContain('&lt;A&gt;');
  });
  it('namespaces IDs without changing the shared layout or action labels', () => {
    const html = movementPhaseHtml(2, 1, 3, 'A → B');
    expect(phaseIds(html, 'mp-').replaceAll('id="mp-', 'id="')).toBe(html);
    expect(phaseIds(html, 'ms-')).toContain('id="ms-move-confirm"');
  });
});
