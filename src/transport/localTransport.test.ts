import { describe, expect, it } from 'vitest';
import { generateBotSetupPlacement, generateBotTurnPlan } from '../ai/dumbBot';
import { sha256Hex } from '../crypto/prng';
import { computeStateHash } from '../crypto/stateHash';
import { GameRuleError } from '../engine/errors';
import type { GameEvent } from '../types/protocol';
import { LocalGame, replayEventLog } from './localTransport';
import { computeGameStats } from './gameStats';
import type { TurnOutcome } from './transport';

const fixedRandom = (tag: string) => { let n = 0; return () => sha256Hex(`${tag}:${n++}`); };

function newGame(players = 4, tag = 'local') {
  return LocalGame.create({ playerCount: players, mapSeed: `MAP-${tag}`, random: fixedRandom(tag) });
}

/** Human seat is driven by the bot planner so the game can run unattended. */
async function playToEnd(game: LocalGame, maxTurns = 3000): Promise<TurnOutcome[]> {
  const outcomes: TurnOutcome[] = [];
  if (game.getState().phase === 'SETUP_PLACEMENT') await game.submitSetupPlacement(generateBotSetupPlacement(game.map, game.getState(), 0));
  for (let i = 0; i < maxTurns && game.getState().phase !== 'GAME_OVER'; i++) {
    outcomes.push(game.isLocalTurn() ? await game.submitTurnCommit(generateBotTurnPlan(game.map, game.getState())) : (await game.playBotTurn())!);
  }
  return outcomes;
}

describe('LocalGame.create', () => {
  it('bots place setup immediately; the human is still pending', () => {
    const game = newGame(4);
    const s = game.getState();
    expect(s.phase).toBe('SETUP_PLACEMENT');
    expect(s.players.map(p => p.setupDone)).toEqual([false, true, true, true]);
    expect(s.players.map(p => p.isBot)).toEqual([false, true, true, true]);
    expect(game.getEvents().map(e => e.payload.kind)).toEqual(['GAME_CREATE', 'SETUP_PLACEMENT', 'SETUP_PLACEMENT', 'SETUP_PLACEMENT']);
  });

  it('uses real hash-chain commitments for every player', () => {
    const create = newGame(3).getEvents()[0].payload;
    if (create.kind !== 'GAME_CREATE') throw new Error();
    expect(new Set(create.players.map(p => p.hashCommitment)).size).toBe(3);
    create.players.forEach(p => expect(p.hashCommitment).toMatch(/^[0-9a-f]{64}$/));
  });

  it('starts turn 1 after the human submits setup', async () => {
    const game = newGame(3);
    const s = await game.submitSetupPlacement(generateBotSetupPlacement(game.map, game.getState(), 0));
    expect(s.phase).toBe('ACTIVE_TURN_COMMIT');
    expect(game.isLocalTurn()).toBe(true);
  });

  it('refuses another seat\'s setup and out-of-turn commits', async () => {
    const game = newGame(3);
    await expect(game.submitSetupPlacement({ type: 'SETUP_PLACEMENT', playerIndex: 1, placements: [] })).rejects.toThrow(GameRuleError);
    await expect(game.submitTurnCommit(generateBotTurnPlan(game.map, game.getState()))).rejects.toThrow(GameRuleError);
    expect(await game.playBotTurn()).toBeNull();
  });
});

describe('turn pipeline', () => {
  it('records commit then reveal for every turn and notifies listeners', async () => {
    const game = newGame(3, 'pipeline');
    const heard: TurnOutcome[] = [];
    const off = game.onTurnResolved(o => heard.push(o));
    const outcomes = await playToEnd(game);
    off();
    expect(heard).toEqual(outcomes);
    expect(game.getState().phase).toBe('GAME_OVER');
    for (const o of outcomes) {
      expect(o.reveal.payload.commitEventId).toBe(o.commit.id);
      expect(o.reveal.seq).toBe(o.commit.seq + 1);
      expect(o.reveal.payload.expectedNewStateHash).toBe(o.resolution.newStateHash);
    }
  });

  it('rejects an invalid plan without consuming a secret or recording events', async () => {
    const game = newGame(3, 'invalid');
    await game.submitSetupPlacement(generateBotSetupPlacement(game.map, game.getState(), 0));
    const before = game.getEvents().length;
    const plan = generateBotTurnPlan(game.map, game.getState());
    await expect(game.submitTurnCommit({ ...plan, draftPlacements: [] })).rejects.toThrow(GameRuleError);
    expect(game.getEvents()).toHaveLength(before);
    await game.submitTurnCommit(plan);
    expect(game.getEvents()).toHaveLength(before + 2);
  });
});

describe('event log', () => {
  it.each([2, 4, 6])('a %i-player game replays from text to the identical final state', async players => {
    const game = newGame(players, `replay-${players}`);
    await playToEnd(game);
    const { state } = replayEventLog(game.exportEventLog());
    expect(computeStateHash(state)).toBe(computeStateHash(game.getState()));
    expect(state.winnerIndex).toBe(game.getState().winnerIndex);
  });

  it('detects tampering', async () => {
    const game = newGame(3, 'tamper');
    await playToEnd(game, 6);
    const events = JSON.parse(game.exportEventLog()) as GameEvent[];
    const reveal = events.findIndex(e => e.payload.kind === 'TURN_REVEAL');

    const badSecret = structuredClone(events);
    const p = badSecret[reveal].payload;
    if (p.kind === 'TURN_REVEAL') p.revealedSecret = 'f'.repeat(64);
    expect(() => replayEventLog(JSON.stringify(badSecret))).toThrow(/id does not match/);

    const reordered = structuredClone(events);
    [reordered[reveal], reordered[reveal - 1]] = [reordered[reveal - 1], reordered[reveal]];
    expect(() => replayEventLog(JSON.stringify(reordered))).toThrow(GameRuleError);

    expect(() => replayEventLog(JSON.stringify(events.slice(1)))).toThrow(GameRuleError);
  });
});

describe('save / restore', () => {
  it('resuming mid-game continues exactly like an uninterrupted game', async () => {
    const a = newGame(4, 'resume');
    const b = newGame(4, 'resume');
    await playToEnd(a, 25);
    await playToEnd(b, 25);
    const resumed = LocalGame.restore(JSON.parse(JSON.stringify(b.save())));
    expect(computeStateHash(resumed.getState())).toBe(computeStateHash(a.getState()));
    await playToEnd(a);
    await playToEnd(resumed);
    expect(computeStateHash(resumed.getState())).toBe(computeStateHash(a.getState()));
    expect(resumed.exportEventLog()).toBe(a.exportEventLog());
  });

  it('rejects chains that do not match the log', async () => {
    const game = newGame(3, 'desync');
    await playToEnd(game, 10);
    const save = game.save();
    save.chains[0].used += 1;
    expect(() => LocalGame.restore(save)).toThrow(GameRuleError);
  });
});

describe('interactive turns', () => {
  async function toLocalTurn(game: LocalGame): Promise<void> {
    if (game.getState().phase === 'SETUP_PLACEMENT') await game.submitSetupPlacement(generateBotSetupPlacement(game.map, game.getState(), 0));
    while (!game.isLocalTurn()) await game.playBotTurn();
  }

  function draftOnly(game: LocalGame) {
    return { ...generateBotTurnPlan(game.map, game.getState()), attackQueue: [], fortify: null };
  }

  it('does not declare victory for owning only half the map', async () => {
    const game = newGame(2, 'interactive-majority');
    await toLocalTurn(game);
    const turn = game.startInteractiveTurn(draftOnly(game));
    turn.liveState.territories.forEach((t, i) => { t.owner = i === 0 ? 1 : 0; });
    const outcome = game.finishInteractiveTurn(turn);
    expect(outcome.resolution.newState.phase).toBe('ACTIVE_TURN_COMMIT');
    expect(outcome.resolution.newState.winnerIndex).toBeNull();
    expect(game.getState().activePlayerIndex).toBe(1);
  });

  it('records complete interactive conquests through victory with replayable statistics and saves', async () => {
    const game = newGame(2, 'interactive-victory');
    await toLocalTurn(game);
    const outcomes: TurnOutcome[] = [];
    game.onTurnResolved(o => outcomes.push(o));
    for (let n = 0; n < 1000 && game.getState().phase !== 'GAME_OVER'; n++) {
      const plan = generateBotTurnPlan(game.map, game.getState());
      let turn = game.startInteractiveTurn({ ...plan, attackQueue: [], fortify: null });
      for (const order of plan.attackQueue) {
        const attack = game.executeInteractiveAttack(turn, { ...order, occupyMode: { type: 'NONE' } });
        turn = attack.state;
        if (attack.result.attack.conquered) {
          turn = game.moveTroopsToConquered(turn, order.fromTerritoryId, order.toTerritoryId,
            turn.liveState.territories[order.fromTerritoryId].troops - 1).state;
        }
        if (turn.liveState.territories.every(t => t.owner === turn.playerIndex)) break;
      }
      const outcome = game.finishInteractiveTurn(turn);
      expect(outcomes).toHaveLength(n + 1);
      expect(outcome.commit.payload.kind).toBe('TURN_COMMIT');
      expect(outcome.reveal.payload.commitEventId).toBe(outcome.commit.id);
      expect(outcome.reveal.payload.expectedNewStateHash).toBe(outcome.resolution.newStateHash);
      expect(outcome.resolution.attackLogs).toEqual(turn.attackLogs);
      if (n === 5) {
        const restored = LocalGame.restore(game.save());
        expect(computeStateHash(restored.getState())).toBe(computeStateHash(game.getState()));
      }
    }

    const final = game.getState();
    expect(final.phase).toBe('GAME_OVER');
    expect(final.territories.every(t => t.owner === final.winnerIndex && t.troops > 0)).toBe(true);
    expect(game.isBotTurn()).toBe(false);
    expect(game.isLocalTurn()).toBe(false);
    expect(await game.playBotTurn()).toBeNull();
    expect(outcomes.at(-1)!.resolution.cardDrawn).toBe(false);
    expect(outcomes.at(-1)!.resolution.turnNumber).toBe(final.turnNumber);

    const replay = replayEventLog(game.exportEventLog());
    expect(computeStateHash(replay.state)).toBe(computeStateHash(final));
    expect(computeStateHash(LocalGame.restore(game.save()).getState())).toBe(computeStateHash(final));
    const stats = computeGameStats(game.exportEventLog());
    expect(stats.winnerIndex).toBe(final.winnerIndex);
    expect(stats.turns).toBe(outcomes.length);
    expect(stats.players[final.winnerIndex!].peakTerritories).toBe(game.map.territories.length);
    expect(stats.players.reduce((sum, p) => sum + p.captures, 0))
      .toBe(outcomes.reduce((sum, o) => sum + o.resolution.attackLogs.filter(a => a.conquered).length, 0));
    expect(stats.players.reduce((sum, p) => sum + p.troopsKilled, 0))
      .toBe(stats.players.reduce((sum, p) => sum + p.troopsLost, 0));
  });

  it('awards no card when nothing is conquered', async () => {
    const game = newGame(2, 'interactive-no-card');
    await toLocalTurn(game);
    const turn = game.startInteractiveTurn(draftOnly(game));
    const outcome = game.finishInteractiveTurn(turn);
    expect(outcome.resolution.cardDrawn).toBe(false);
    expect(game.getState().players[0].cards).toEqual([]);
  });

  it('replays an interactive fortification followed by a normal bot turn', async () => {
    const game = newGame(2, 'interactive-fortify');
    await toLocalTurn(game);
    let turn = game.startInteractiveTurn(draftOnly(game));
    const from = game.map.territories.find(t => turn.liveState.territories[t.id].owner === 0
      && turn.liveState.territories[t.id].troops > 1
      && t.neighbors.some(n => turn.liveState.territories[n].owner === 0))!;
    expect(from).toBeDefined();
    const to = from.neighbors.find(n => turn.liveState.territories[n].owner === 0)!;
    turn = game.executeInteractiveFortify(turn, { fromTerritoryId: from.id, toTerritoryId: to, troops: 1 }).state;
    const outcome = game.finishInteractiveTurn(turn);
    expect(outcome.resolution.fortify?.executed).toBe(true);
    expect(computeStateHash(LocalGame.restore(game.save()).getState())).toBe(computeStateHash(game.getState()));
    await game.playBotTurn();
    expect(computeStateHash(LocalGame.restore(game.save()).getState())).toBe(computeStateHash(game.getState()));
    expect(computeGameStats(game.exportEventLog()).turns).toBe(2);
  });

  it('draws one real deck card after a conquest, so hands keep unique card ids and stay tradable', async () => {
    const game = newGame(2, 'interactive-card');
    for (let turn = 0; turn < 3; turn++) {
      await toLocalTurn(game);
      const deckBefore = game.getState().deck.length;
      let state = game.startInteractiveTurn(draftOnly(game));
      const live = state.liveState;
      const from = game.map.territories.find(t => live.territories[t.id].owner === 0 && t.neighbors.some(n => live.territories[n].owner !== 0))!.id;
      const to = game.map.territories[from].neighbors.find(n => live.territories[n].owner !== 0)!;
      live.territories[from].troops = 40;
      live.territories[to].troops = 1;
      ({ state } = game.executeInteractiveAttack(state, { orderId: `t${turn}`, fromTerritoryId: from, toTerritoryId: to, stopWhenAttackerAtOrBelow: 0, occupyMode: { type: 'NONE' } }));
      expect(state.conqueredAny).toBe(true);
      const outcome = game.finishInteractiveTurn(state);
      expect(outcome.resolution.cardDrawn).toBe(true);
      expect(game.getState().deck.length).toBe(deckBefore - 1);
    }
    const ids = game.getState().players[0].cards.map(c => c.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(id => id >= 0)).toBe(true);
  });
});
