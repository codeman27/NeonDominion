# Neon Dominion — Build Checklist

This is the single source of truth for **where the project is**. Work through the steps **one at a time, in order**. Design details live in [ARCHITECTURE.md](./ARCHITECTURE.md); each step links the section it implements.

## How to work this list (humans and models)

1. Pick the first step marked `[ ]` (or `[~]` if it's in progress). Don't skip ahead unless a step says it can be done in parallel.
2. Read the linked ARCHITECTURE section and the **Done when** criteria before writing code.
3. Before marking a step done, all of these must pass:
   - `npm test`
   - `npm run typecheck`
   - `npm run build`
   - the step's own **Done when** checks
4. Update this file: tick the box, add a one-line **Notes** entry if anything deviated from the spec, and update ARCHITECTURE.md if a design changed.
5. Commit with the step number in the message, for example `1.4: hash chain module`.

Status legend: `[x]` done · `[~]` in progress · `[ ]` not started · `[!]` blocked (explain in Notes)

---

## Phase 0 — Design

- [x] **0.1 Architecture spec**: [ARCHITECTURE.md](./ARCHITECTURE.md) covers rules, Nostr commit-reveal protocol, data types, and roadmap.
- [x] **0.2 Art direction**: Style A "Neon Grid", mobile-first. Clickable mockups are in [mockups/](./mockups/index.html). Spec: §9.

## Phase 1 — Single player vs. dumb bots

### Foundations
- [x] **1.1 Project scaffold**: Vite + TypeScript (strict) + Vitest; local Orbitron / Share Tech Mono fonts.
- [x] **1.2 Deterministic PRNG**: `src/crypto/prng.ts` (SHA-256 counter DRBG, `nextInt`, `shuffle`, `fork`) plus tests. Spec: §7.1.
- [x] **1.3 Map generator + Map Lab**: continents-first generator, chokepoints, continent bonus `⌊T/3⌋ + entries`, and a Map Lab page with ⟳ Generate New Map. Spec: §3.
  - Notes: `MAP_GENERATOR_VERSION = 2`. Ownership is NOT part of map generation; it's dealt at game start (1.7).
- [x] **1.4 Hash chain module**
  - Goal: `src/crypto/hashChain.ts` with these functions:
    - `createHashChain(rootSecret, length)` returns `{ head C₀, secrets[] }`.
    - `verifyReveal(prevCommitment, secret)` checks the next reveal against the current head.
    - `advance(prevCommitment, secret)` returns the new head.
  - Done when: tests cover a valid chain, a wrong secret, an out-of-order reveal, and determinism.
  - Spec: §5.1.
  - Notes: done in `src/crypto/hashChain.ts`.
    - Hashing is over the raw 32 bytes and values are canonical lowercase hex.
    - The owner side uses `HashChainCursor`, which saves and restores `{ root, length, used }`.
    - Verification is strictly next-in-order; skipping ahead or replaying a secret is rejected.
- [ ] **1.5 Canonical state hash** ← **NEXT**
  - Goal: `src/crypto/stateHash.ts` with `canonicalStringify` (sorted keys, no `undefined`, integers only) and `computeStateHash(state)`.
  - Done when: key order doesn't change the hash; any field change does; the hash is pinned to a known vector.
  - Spec: §7.2.

### Rules engine (pure functions, no DOM)
- [ ] **1.6 Game & action types**
  - Goal: `src/types/game.ts` (add `GameState`, `PlayerState`, `TerritoryState`, `TerritoryCard`, `GamePhase`) and `src/types/actions.ts` (plans, orders, resolution logs).
  - Done when: everything type-checks and matches §6.1–6.2 exactly. Note any deviations in ARCHITECTURE.
- [ ] **1.7 Game setup & deal**
  - Goal: `createGame({ map, players, setupSeed })`:
    - Deal territories round-robin from a seeded shuffle, 1 troop each.
    - Build and shuffle the card deck (1 card per territory with balanced emblems, plus 2 WILD).
    - Compute setup troop pools from §3.1.
  - Also `applySetupPlacement()` with validation.
  - Done when: deals are even and deterministic, deck composition is correct, and invalid placements are rejected.
  - Spec: §4.1.
- [ ] **1.8 Reinforcements & cards**
  - Goal: `src/engine/rules.ts`:
    - Base reinforcements `max(3, ⌊owned/3⌋)`.
    - Continent bonuses.
    - Card set validation and values (4 / 6 / 8 / 10, WILD substitutes).
    - Mandatory trade at 5+ cards.
    - +2 territory-match bonus.
  - Done when: table-driven tests cover every set type, WILD combinations, and the mandatory-trade rule.
  - Spec: §4.2.1.
- [ ] **1.9 Combat resolver**
  - Goal: `src/engine/combatResolver.ts`:
    - Classic 3v2 waves with ties going to the defender.
    - `stopWhenAttackerAtOrBelow` threshold.
    - Occupy modes.
    - Chained attacks; an order from an uncaptured territory is skipped.
    - Friendly-fire guard.
    - Elimination with card transfer.
  - Done when: scripted-dice tests cover each rule, and a statistical test shows attacker win rates within the expected ranges.
  - Spec: §4.2.2.
- [ ] **1.10 Fortify**
  - Goal: connected-path BFS over owned territories; troops are clamped so at least 1 always stays behind.
  - Done when: tests cover connected, disconnected, not-owned, and over-move cases.
  - Spec: §4.2.3.
- [ ] **1.11 Turn engine**
  - Goal: `validateTurnPlan()` and `applyTurn(state, plan, commitId, revealedSecret)` returning a `TurnResolutionResult`. It handles:
    - Turn seed `SHA256(commitId:secret)`.
    - Draft, attacks, and fortify, in that order.
    - Card draw.
    - Advancing to the next alive player.
    - Win detection.
    - `prevStateHash` chaining.
  - Done when: the same inputs produce an identical result and hash; replaying a full game log reproduces the final state.
  - Spec: §4.2, §5.2.

### Bots & local game loop
- [ ] **1.12 Dumb bot AI**
  - Goal: `src/ai/dumbBot.ts` with setup placement and whole-turn plans.
  - Done when: 100 seeded bots-only games (2–8 players) all finish with a winner, with no invalid plans and no infinite loops (turn cap).
  - Spec: §8.
- [ ] **1.13 Local transport**
  - Goal: `src/transport/localTransport.ts` that:
    - Gives every player (human and bots) a real hash chain.
    - Runs each turn through the actual commit → reveal → `applyTurn` pipeline.
    - Can export the full text event log.
  - Done when: a full bots-only game runs through the transport and the exported log replays to the same final hash.
  - Spec: §10.

### UI (mobile-first; the 390×844 portrait layout is the primary target)
- [ ] **1.14 App shell & main menu**
  - Goal: screen router; the main menu from the mockup with Solo / Nostr 🔒, a commanders stepper, a live map preview reusing the Map Lab renderer, ⟳ New Map, Advanced seed, and Start. Keep the Map Lab reachable (for example at `?lab`).
  - Spec: §9.3.1.
- [ ] **1.15 Setup placement screen**
  - Goal: show dealt territories in player colors; tap to place starting troops; confirm. Bots place instantly.
- [ ] **1.16 Game board & phase sheet**
  - Goal: full-screen map in owner colors with troop badges; bottom sheet for Draft → Attack (chained orders, stop/occupy chips) → Fortify → Commit; ☰ intel drawer; territory info pill; pan / pinch / zoom.
  - Spec: §9.2–9.3.2.
- [ ] **1.17 Commit overlay & battle replay**
  - Goal: sealing → reveal overlay; replay player (camera follows each battle, dice waves, captures, Skip / 1× / 2×); bot turns replay too, with an "auto-skip bots" setting.
  - Spec: §9.3.3.
- [ ] **1.18 Victory & text inspector**
  - Goal: victory screen with stats; inspector drawer showing the raw JSON events and hash-chain reveals (proves the game is "all text").
- [ ] **1.19 Desktop layout & polish**
  - Goal: three-column layout at ≥ 700 px, keyboard shortcuts, saving the game to localStorage and resuming.
  - Done when: a full single-player game plays from menu to victory at both 390×844 and 1600×900.

## Phase 2 — Nostr multiplayer

- [ ] **2.1 Protocol decisions**: resolve the open issues in §5.4 (witness timeout, collusion mitigation, setup seed commit-reveal, chain rotation) and update ARCHITECTURE §5.
- [ ] **2.2 Identity**: NIP-07 browser-extension login with an ephemeral local keypair as fallback; profile name and color.
- [ ] **2.3 Event schemas**: `src/types/protocol.ts`, plus signing and verification helpers with `nostr-tools`. Spec: §6.3.
- [ ] **2.4 Nostr transport**: relay pool, subscriptions, commit → reveal flow, quorum check, and rebroadcasting to lagging relays. Spec: §5.2–5.3, §10.
- [ ] **2.5 Equivocation handling**: detect conflicting commits, publish proofs, and apply the deterministic resolution rule. Spec: §5.3.
- [ ] **2.6 Lobby & setup**: create/join a game, pick relays, setup commit-reveal for the map seed and deal.
- [ ] **2.7 Async play**: resume from relays, catch up on missed turns via hash-chain validation, and turn notifications.
- [ ] **2.8 Multi-relay test harness**: local relays plus scripted adversarial clients (equivocation, stalling, stale relays).

---

## Handoff notes

_Append a short entry when you stop mid-phase or hand off to another model._

- **2026-10-22**: Steps 0.1–1.3 are done. 115 tests pass. Next up is 1.4. The Map Lab runs with `npm run dev`.
- **2026-10-22**: 1.4 is done (131 tests). Next up is 1.5.
