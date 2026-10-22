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

**Model fit** (who should take each open step):

| Tag | Meaning |
|---|---|
| 🟢 **LOCAL** | Fine for a local model such as **Qwen 3.6 35B**: one module, pure logic, precise spec, and tests define "done". |
| 🟡 **LOCAL + REVIEW** | A local model can write it, but a frontier model (or you) should review the diff before ticking the box. These steps have subtle rules or UI judgment. |
| 🔴 **FRONTIER** | Use a frontier model. These steps tie many modules together, depend on determinism or security subtleties, or need complex interactive UI state. |

### Handing a step to a local model
- **Keep its context small.** Paste the step text, the linked ARCHITECTURE section, the **Determinism rules** below, and only the files the step names. Don't paste the whole repo.
- **Make it write the tests first** from **Done when**, then the code, and run `npm test && npm run typecheck` until green.
- **Forbid design changes.** If the spec is unclear, it should stop and write the question in **Notes** (mark `[!]`) rather than guess.
- **Give it a prompt like:** *"Implement CHECKLIST step X.Y exactly as specified. Only create/modify these files: … Follow the determinism rules. Write tests first. Do not change any other file or any public API not named in the step."*

### Determinism rules (every engine step)
- **No `Math.random()`.** All randomness comes from `DeterministicRng` (`src/crypto/prng.ts`), using `rng.fork('<label>')` for each sub-system.
- **No floating-point game math.** Use integers only, with `Math.floor` for division. Never use `Math.sin`, `Math.cos`, `Math.sqrt`, or `Math.pow` on game values.
- **Ordered iteration only.** Iterate arrays or sorted keys, never object or Set iteration over data that arrived from outside.
- **Pure functions.** Engine functions never mutate their input state; they return a new state (`structuredClone` is fine).

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
- [x] **1.5 Canonical state hash** `🟢 LOCAL`
  - Goal: `src/crypto/stateHash.ts`.
  - `canonicalStringify(value)` rules:
    - Objects are written with keys sorted by plain string comparison.
    - Arrays keep their order.
    - Allowed values: strings, booleans, `null`, and safe integers. Throw on non-integer numbers, `NaN`, `Infinity`, `undefined` values, functions, `Map`/`Set`, and class instances.
    - Output is JSON with no whitespace.
  - `computeStateHash(state)` = SHA-256 hex of the UTF-8 bytes of `canonicalStringify({ ...state, prevStateHash: '' })`. Reuse `sha256Hex` from `prng.ts`.
  - Files: `src/crypto/stateHash.ts` and `src/crypto/stateHash.test.ts` only.
  - Done when:
    - Key order doesn't change the hash, and any field change does.
    - Floats, `undefined`, and `NaN` throw.
    - Nested arrays and objects are handled.
    - The hash of `{ b: 1, a: [2, { d: 'x', c: null }] }` is pinned in the test.
  - Spec: §7.2.

### Rules engine (pure functions, no DOM)
  - Notes: Started by the local model and finished by Copilot: `computeStateHash` now accepts any object, and tests were added (the pinned vector was computed independently with Node crypto).
- [x] **1.6 Game & action types** `🟢 LOCAL`
  - Goal: `src/types/game.ts` (add `GameState`, `PlayerState`, `TerritoryState`, `TerritoryCard`, `GamePhase`) and `src/types/actions.ts` (plans, orders, resolution logs).
  - Files: `src/types/game.ts` (append; keep the existing map types unchanged) and `src/types/actions.ts`.
  - `GameState.territories` must be an **array** indexed by territory id (`TerritoryState[]`), not a `Record`, so key order can never matter. Players are referenced by **index** (`number`) inside `GameState`; `PlayerState.id` stays a string (it will hold a pubkey later).
  - Done when: everything type-checks and matches §6.1–6.2 apart from the two changes above. Record them in ARCHITECTURE §6.
  - Notes: Deviations from §6 are recorded at the top of ARCHITECTURE §6: territories array, seat-index players, map not stored in state, setupTroops in PlayerState, simplified GamePhase.
- [x] **1.7 Game setup & deal** `🟢 LOCAL`
  - Goal: `createGame({ map, players, setupSeed })`:
    - Deal territories round-robin from a seeded shuffle, 1 troop each.
    - Build and shuffle the card deck (1 card per territory with balanced emblems, plus 2 WILD).
    - Compute setup troop pools from §3.1.
  - Also `applySetupPlacement()` with validation.
  - File: `src/engine/setup.ts` (+ test).
  - Exact rules:
    - Shuffle territory ids with `rng.fork('deal')` and deal round-robin from player index 0.
    - Starting troops per player: `{2:35, 3:35, 4:30, 5:25, 6:20, 7:20, 8:20}`. Setup pool = starting troops − territories dealt.
    - Deck: shuffle territory ids with `rng.fork('emblems')`, then assign emblems cycling `INFANTRY → CAVALRY → ARTILLERY` along that order. Add 2 `WILD` cards (`territoryId: null`).
    - Card ids are `0..T+1`, with territory cards first in territory-id order and the wilds last. Shuffle the deck with `rng.fork('deck')`.
    - `applySetupPlacement` rejects: territories not owned by that player, negative or non-integer amounts, totals that don't equal the pool, and a second submission.
  - Done when: deals are even and deterministic, emblem counts differ by at most 1, the deck has `T+2` cards, and every invalid placement case is rejected.
  - Spec: §4.1.
  - Notes: `createGame` seeds its RNG with `SHA256('SETUP:gameId:setupSeed')`. `GameRuleError` is in `src/engine/errors.ts`, and shared fixtures are in `src/engine/testing.ts`.
- [x] **1.8 Reinforcements & cards** `🟢 LOCAL`
  - Goal: `src/engine/rules.ts`:
    - Base reinforcements `max(3, ⌊owned/3⌋)`.
    - Continent bonuses.
    - Card set validation and values (4 / 6 / 8 / 10, WILD substitutes).
    - Mandatory trade at 5+ cards.
    - +2 territory-match bonus.
  - File: `src/engine/rules.ts` (+ test). These are pure helper functions; they don't apply anything to state.
  - Exact rules:
    - `baseReinforcements(owned) = max(3, floor(owned / 3))`.
    - `continentBonus` for a player = the sum of `continent.bonus` for every continent they own 100% of.
    - `cardSetValue(cards)` returns `null` if the 3 cards aren't a valid set. Valid sets: three of the same emblem (INF 4 · CAV 6 · ART 8), or one of each (10). A WILD stands in for anything; with WILDs, use the highest-value set possible.
    - `mustTrade(handSize) = handSize >= 5`.
    - Territory-match bonus: +2 troops on each traded card's territory that the player owns. At most one +2 per traded set (use the first matching card in the order given).
  - Done when: table-driven tests cover every set type, every WILD combination, invalid sets, and the mandatory-trade rule.
  - Spec: §4.2.1.
  - Notes: Also added `bestSet(hand)` (highest-value set, ties broken by lowest card ids) for bots and the UI.
- [x] **1.9 Combat resolver** `🟡 LOCAL + REVIEW`
  - Goal: `src/engine/combatResolver.ts`:
    - Classic 3v2 waves with ties going to the defender.
    - `stopWhenAttackerAtOrBelow` threshold.
    - Occupy modes.
    - Chained attacks; an order from an uncaptured territory is skipped.
    - Friendly-fire guard.
    - Elimination with card transfer.
  - File: `src/engine/combatResolver.ts` (+ test). Dice come from a passed-in `rollD6: () => number` so tests can script them.
  - Exact rules:
    - **Wave:** the attacker rolls `min(3, attackerTroops − 1)` dice and the defender rolls `min(2, defenderTroops)`. Sort both descending and compare pairwise; ties go to the defender.
    - **Stop:** stop when the defender has 0 troops, or when `attackerTroops <= max(1, stopWhenAttackerAtOrBelow)`.
    - **Conquest move:** min = the number of dice the attacker rolled in the final wave; max = `attackerTroops − 1`. The mode picks within that range:
      - `MIN` → min
      - `ALL_BUT_ONE` → max
      - `HALF` → `clamp(floor(attackerTroops / 2), min, max)`
      - `LEAVE_BEHIND n` → `clamp(attackerTroops − n, min, max)`
    - **Skip (logged with a reason, no dice rolled):** the source isn't owned by the attacker; the target is owned by the attacker; the two aren't adjacent; or the source has ≤ the stop threshold or fewer than 2 troops.
    - **Elimination:** a defender with no territories left is marked eliminated, and their cards move to the attacker.
  - Done when: scripted-dice tests cover each rule including chains (A→B then B→C, with the chain skipped when B wasn't taken), and a 10,000-battle statistical test shows a 3v2 single-wave attacker "both kills" rate of ≈ 37.2% ± 2%.
  - Spec: §4.2.2.
  - Notes: Written by Copilot (frontier), so no separate review was needed. `resolveAttack` mutates a working clone; the pure entry point is `resolveAttackQueue`. 3v2 single-wave odds are verified statistically (37.2% / 33.6% / 29.3%).
- [x] **1.10 Fortify** `🟢 LOCAL`
  - Goal: connected-path BFS over owned territories; troops are clamped so at least 1 always stays behind.
  - File: `src/engine/fortify.ts` (+ test). `applyFortify(state, playerIdx, order)` returns `{ state, executed, skippedReason? }`.
  - Exact rules: the path may only pass through territories the player owns. Troops moved = `min(order.troops, from.troops − 1)`; if that's ≤ 0, skip. A zero or negative request is skipped.
  - Done when: tests cover connected, disconnected (owned but no owned path), not-owned, same-territory, and over-move cases.
  - Spec: §4.2.3.
  - Notes: The signature takes the map: `applyFortify(map, state, player, order)`. Also exported `connectedOwned()` for the UI to highlight destinations.
- [ ] **1.11 Turn engine** `🔴 FRONTIER` ← **NEXT**
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
- [ ] **1.12 Dumb bot AI** `🟡 LOCAL + REVIEW`
  - Goal: `src/ai/dumbBot.ts` with setup placement and whole-turn plans.
  - Done when: 100 seeded bots-only games (2–8 players) all finish with a winner, with no invalid plans and no infinite loops (turn cap).
  - Spec: §8.
- [ ] **1.13 Local transport** `🔴 FRONTIER`
  - Goal: `src/transport/localTransport.ts` that:
    - Gives every player (human and bots) a real hash chain.
    - Runs each turn through the actual commit → reveal → `applyTurn` pipeline.
    - Can export the full text event log.
  - Done when: a full bots-only game runs through the transport and the exported log replays to the same final hash.
  - Spec: §10.

### UI (mobile-first; the 390×844 portrait layout is the primary target)
- [ ] **1.14 App shell & main menu** `🟡 LOCAL + REVIEW`
  - Goal: screen router; the main menu from the mockup with Solo / Nostr 🔒, a commanders stepper, a live map preview reusing the Map Lab renderer, ⟳ New Map, Advanced seed, and Start. Keep the Map Lab reachable (for example at `?lab`).
  - Spec: §9.3.1.
- [ ] **1.15 Setup placement screen** `🟡 LOCAL + REVIEW`
  - Goal: show dealt territories in player colors; tap to place starting troops; confirm. Bots place instantly.
- [ ] **1.16 Game board & phase sheet** `🔴 FRONTIER`
  - Goal: full-screen map in owner colors with troop badges; bottom sheet for Draft → Attack (chained orders, stop/occupy chips) → Fortify → Commit; ☰ intel drawer; territory info pill; pan / pinch / zoom.
  - Spec: §9.2–9.3.2.
- [ ] **1.17 Commit overlay & battle replay** `🔴 FRONTIER`
  - Goal: sealing → reveal overlay; replay player (camera follows each battle, dice waves, captures, Skip / 1× / 2×); bot turns replay too, with an "auto-skip bots" setting.
  - Spec: §9.3.3.
- [ ] **1.18 Victory & text inspector** `🟢 LOCAL`
  - Goal: victory screen with stats; inspector drawer showing the raw JSON events and hash-chain reveals (proves the game is "all text").
  - Uses the event log exported by 1.13. Read-only UI, no engine changes.
- [ ] **1.19 Desktop layout & polish** `🟡 LOCAL + REVIEW`
  - Goal: three-column layout at ≥ 700 px, keyboard shortcuts, saving the game to localStorage and resuming.
  - Done when: a full single-player game plays from menu to victory at both 390×844 and 1600×900.

## Phase 2 — Nostr multiplayer

- [ ] **2.1 Protocol decisions** `🔴 FRONTIER`: resolve the open issues in §5.4 (witness timeout, collusion mitigation, setup seed commit-reveal, chain rotation) and update ARCHITECTURE §5.
- [ ] **2.2 Identity** `🟡 LOCAL + REVIEW`: NIP-07 browser-extension login with an ephemeral local keypair as fallback; profile name and color.
- [ ] **2.3 Event schemas** `🟡 LOCAL + REVIEW`: `src/types/protocol.ts`, plus signing and verification helpers with `nostr-tools`. Spec: §6.3.
- [ ] **2.4 Nostr transport** `🔴 FRONTIER`: relay pool, subscriptions, commit → reveal flow, quorum check, and rebroadcasting to lagging relays. Spec: §5.2–5.3, §10.
- [ ] **2.5 Equivocation handling** `🔴 FRONTIER`: detect conflicting commits, publish proofs, and apply the deterministic resolution rule. Spec: §5.3.
- [ ] **2.6 Lobby & setup** `🔴 FRONTIER`: create/join a game, pick relays, setup commit-reveal for the map seed and deal.
- [ ] **2.7 Async play** `🔴 FRONTIER`: resume from relays, catch up on missed turns via hash-chain validation, and turn notifications.
- [ ] **2.8 Multi-relay test harness** `🔴 FRONTIER`: local relays plus scripted adversarial clients (equivocation, stalling, stale relays).

---

## Handoff notes

_Append a short entry when you stop mid-phase or hand off to another model._

- **2026-10-22**: Steps 0.1–1.3 are done. 115 tests pass. Next up is 1.4. The Map Lab runs with `npm run dev`.
- **2026-10-22**: 1.4 is done (131 tests). Next up is 1.5. Added model-fit tags. Steps 1.5–1.8 and 1.10 are 🟢 and can go to a local model one at a time; tightened specs for 1.5–1.10 so no design decisions are left to it.
