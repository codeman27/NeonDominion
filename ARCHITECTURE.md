# Nostr Risk Clone — System Architecture & Implementation Guide

> **Handoff Specification for Implementation**
> This document defines the complete architecture, deterministic state engine, procedural hex-cluster map generator, Nostr commit-reveal anti-cheat protocol, multi-relay consensus model, simplistic bot AI, and phased implementation roadmap for a text-serialized Risk clone.

---

## Local Development & Phone Testing

- Run `npm run dev` for local development.
- Run `npm run dev:phone` to listen on all network interfaces at port **5173**. Open the **Network** URL printed by Vite (for example, `http://192.168.1.50:5173`) on a phone connected to the same LAN/Wi-Fi. Do not use `localhost` on the phone.
- If the phone cannot connect, allow incoming TCP port **5173** through the host firewall and check that Wi-Fi client isolation or a guest network is not blocking device-to-device access.
- The phone command fails if port 5173 is already in use; stop the existing server or choose another port with `npm run dev:phone -- --port 5174`.
- Use this development server only on a trusted LAN; do not expose or port-forward it to the internet. Stop it with **Ctrl+C** when finished.

## 1. Executive Summary & Design Goals

1. **Player-Scaled Procedural Maps (`2–8 Players`)**: Maps are generated deterministically from a single seed using **Hex Grid Clusters**—individual axial hexes fused into organic territories, and territories grouped into continents with proportional troop bonuses.
2. **100% Text-Serializable State**: Every map, game state, turn plan, and RNG seed is pure JSON/text so the entire game can be transmitted over **Nostr** events.
3. **Zero-Scumming Turn Execution (Whole-Turn Commit-Reveal)**:
   - A player **cannot** preview dice rolls locally and undo/retry if the rolls go poorly.
   - Instead of rolling one die at a time, the active player constructs a **Whole-Turn Action Plan** (card trade-ins, troop draft placements, ordered attack campaigns with stop thresholds, and a connected-path fortification move) and publishes **1 signed `TurnCommit` event**.
   - Only *after* the `TurnCommit` is signed and broadcast does the next player in turn order publish **1 signed `TurnReveal` event** containing their pre-committed hash-chain secret for that turn.
   - All clients combine `SHA256(turn_commit_event_id + ":" + revealed_secret)` to seed a deterministic PRNG, resolve the entire turn identically, and play back the animated battle sequence.
   - **Relay Cost**: Exactly **2 Nostr events per turn** regardless of how many battles occur.
4. **Multi-Relay Consistency & Anti-Equivocation**:
   - Strict monotonic `turnNumber` + `prevStateHash` hash-chaining prevents state rollback or out-of-order execution.
   - Cryptographic equivocation rules prevent a player from broadcasting two different turn plans to different relays.
5. **Single-Player First, Nostr Multiplayer Ready**:
   - Phase 1 implements the full main menu, map generator, whole-turn planner UI, battle replay visualizer, and gameplay loop in **Single Player vs. Simplistic Dumb Bots** using an in-memory transport adapter.
   - Phase 2 plugs in the Nostr relay transport adapter without modifying the core rules engine or renderer.

---

## 2. Tech Stack & Project Structure

- **Runtime & Bundler**: Vite + TypeScript (Strict Mode, ES2022+)
- **Rendering**: HTML5 `<svg>` (or `<canvas>`) for crisp axial hex-cluster rendering, territory borders, attack plan arrows, and troop badges, paired with clean DOM/CSS overlays for HUD and menus.
- **Cryptography & Nostr**: `@noble/hashes` (SHA-256) and `nostr-tools` (NIP-01 event signing, relay pool management, Schnorr verification).
- **Testing**: Vitest for deterministic engine, PRNG, map connectivity, and state-hash verification tests.

### Recommended Directory Layout

```text
RiskClone/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── src/
    ├── main.ts                        # Entry point & screen router
    ├── types/
    │   ├── game.ts                    # Core GameState, Territory, Continent, Card, Player types
    │   ├── actions.ts                 # TurnActionPlan, AttackOrder, DraftOrder, FortifyOrder
    │   └── protocol.ts                # Nostr event payloads, hash-chain commitments, transport interfaces
    ├── crypto/
    │   ├── prng.ts                    # Deterministic Mulberry32 / ChaCha20 PRNG seeded via SHA-256
    │   ├── hashChain.ts               # Pre-committed SHA-256 hash chain generator & verifier
    │   └── stateHash.ts               # Canonical JSON serializer & SHA-256 state fingerprinter
    ├── engine/
    │   ├── mapGenerator.ts            # Procedural Hex-Cluster territory & continent generator (2–8 players)
    │   ├── hexMath.ts                 # Axial hex coordinates (q, r), neighbors, pixel projection, boundary paths
    │   ├── rules.ts                   # Classic Risk rules: reinforcement calc, fixed card sets, connected fortify
    │   ├── combatResolver.ts          # Deterministic 3v2 Risk dice combat & campaign order execution
    │   ├── turnEngine.ts              # Pure function: applyTurn(state, commit, revealedSeed) -> TurnResolutionResult
    │   └── validators.ts              # Action plan validation & legality checks
    ├── ai/
    │   └── dumbBot.ts                 # Simplistic bot AI (Setup troop placement + Whole-Turn Action Plan generator)
    ├── transport/
    │   ├── transportInterface.ts      # Abstract GameTransport (Local vs Nostr)
    │   ├── localTransport.ts          # Phase 1: Single-player instant commit-reveal + bot runner
    │   └── nostrTransport.ts          # Phase 2: Multi-relay Nostr pool, commit-reveal sync, equivocation detector
    └── ui/
        ├── appController.ts           # Top-level UI state machine (Menu -> Setup -> Planning -> Replay -> GameOver)
        ├── screens/
        │   ├── mainMenu.ts            # Player count, bot count, map seed preview, start game
        │   ├── gameScreen.ts          # Main board container, phase bar, player roster, turn log
        │   └── victoryModal.ts        # Winner summary & stats
        ├── components/
        │   ├── hexMapRenderer.ts      # SVG hex-cluster map, continent outlines, attack arrow overlays (see §9.4)
        │   ├── mapCamera.ts           # Pan / pinch-zoom / fit, portrait view rotation
        │   ├── phaseSheet.ts          # Mobile bottom sheet: Draft -> Attack -> Fortify -> Commit
        │   └── battleReplayPlayer.ts  # Step-by-step animated playback of resolved TurnResolutionResult
        └── styles/
            └── main.css               # UI styling
```

---

## 3. Procedural Hex-Cluster Map Generation (`2–8 Players`) — ✅ implemented

> **Code:** [`src/engine/mapGenerator.ts`](./src/engine/mapGenerator.ts), [`src/engine/hexMath.ts`](./src/engine/hexMath.ts) · **Tests:** [`mapGenerator.test.ts`](./src/engine/mapGenerator.test.ts) · **Visual tool:** the Map Lab (`npm run dev`, then use the ⟳ GENERATE NEW MAP button).

Maps are generated from `(seed, playerCount, MAP_GENERATOR_VERSION)` alone, so no geometry needs to be sent over Nostr. Every client regenerates the identical map. Single-player uses a fresh random seed per game (§9.3). Multiplayer derives the seed from the setup commit-reveal (§5.4).

### 3.1 Scaling Parameters by Player Count (`MAP_SCALE`)

| Players | Territories | Per player | Continents | Starting troops per player |
| :---: | :---: | :---: | :---: | :---: |
| **2** | 14 | 7 | 3 | 35 |
| **3** | 21 | 7 | 4 | 35 |
| **4** | 28 | 7 | 5 | 30 |
| **5** | 30 | 6 | 5 | 25 |
| **6** | 36 | 6 | 6 | 20 |
| **7** | 42 | 6 | 6 | 20 |
| **8** | 48 | 6 | 7 | 20 |

The territory count is always a multiple of the player count, so the deal is perfectly even. Continents hold 3–9 territories each, and sizes are deliberately uneven so there are both small, easy-to-hold continents and big, lucrative ones. Territories hold 3–14 hexes (typically 5–7).

### 3.2 Algorithm: mixed mainlands and island chokepoints

Generator version **3** mixes broad natural frontiers with narrow bridges and sea lanes. Larger continents are paired on shared mainlands; one or two smaller continents remain islands. Each shared frontier has at least two crossing territories on **each** side, so guarding a single territory cannot block all crossings. This replaces version 2's island-only layout. Map version is part of deterministic seeding; old version-2 event logs are rejected explicitly rather than replayed on different terrain.

1. **Continent sizes.** Split `T` territories into `C` continents, then shuffle counts between them so sizes vary (bounded to 3–9).
2. **Canvas and noise.** Create a landscape (~16:10) offset-hex canvas sized so land covers about 40% of it. Add 3-pass smoothed integer value noise (0–1000) to shape coastlines.
3. **Landmass centers.** Rank continents by territory count (ties by ID), pair the larger ones, and leave one or two smaller islands. Choose one center per landmass by farthest-point sampling on interior hexes.
4. **Grow the landmasses together.** On each step, the landmass furthest behind its combined hex budget (territories × 5–7 hexes) claims its best frontier hex, scored as `noise − 34·distanceFromCenter + jitter(0..50)`.
   - **Separation rule:** a hex can't be claimed if another landmass's land is within distance 2, which guarantees at least 2 water hexes between landmasses.
   - A landmass boxed in below 85% of its budget triggers a retry.
   - Divide paired mainlands into two contiguous continent regions with the same farthest-point/balanced-fill partitioner.
5. **Link continents.** For every continent pair, find the closest coastal hex pair whose straight path doesn't graze a third continent. Then:
   - Union natural mainland contacts first, then build a **degree-capped spanning connection** (Kruskal) for guaranteed connectivity.
   - Add `⌊(C−1)/2⌋` **extra short links** (distance ≤ 7) to create alternate routes and loops.
   - No continent gets more than **3 narrow links**, in addition to its natural mainland borders. Do not add narrow links between already touching continents.
6. **Partition each continent into territories.** Use farthest-point seeds, a balanced flood fill (the smallest territory grows next), and 2 Lloyd relaxation passes (re-seed at each territory's medoid).
   - Up to 12 local retries per continent, accepting the first partition where every territory has ≥ 2 neighbors inside the continent. A territory holding a link endpoint needs only ≥ 1, since the link supplies the other border.
   - Territory IDs are numbered continent by continent in reading order.
7. **Materialize chokepoints.**
   - A gap of distance ≤ 4 becomes a **`BRIDGE`**: the 1–3 water hexes on the line become land, with the first half added to territory A and the second half to territory B. A bridge is demoted to a sea lane if it would touch the wrong continent or another bridge.
   - Longer gaps become **`SEA_LANE`**s (adjacency only, drawn as a dotted line).
8. **Validate. Any failure retries with `attempt + 1`, up to 80 attempts:**
   - Territory sizes are within bounds.
   - Every territory has degree ≥ 2.
   - Every cross-continent adjacency is either a paired mainland frontier or a declared chokepoint; bridges cannot accidentally touch unrelated continents.
   - Every paired mainland frontier has at least two distinct border territories on each side.
   - The whole graph is connected.
9. **Name** territories and continents from shuffled lists, and compute **bonuses** (§3.3).

**Version-3 validation:** 105 invariant-test maps plus 350 additional browser-generated maps across 2–8 players. The additional sample had 0 failures, 3.08 retries per map on average, and at most 31 retries (limit: 80).

### 3.3 Continent Bonus

`bonus = clamp(⌊territories / 3⌋ + entryPoints, 2, 10)`, where `entryPoints` is the number of distinct territories in that continent with a neighbor in another continent, counting natural borders, bridges and sea lanes.

Holding a continent pays more when there are more territories to conquer and more entrances to defend. Applied to the classic Risk board this gives Australia (4, 1) → 2, South America (4, 2) → 3, North America (9, 3) → 6, and Asia (12, 5) → 9.

Hex count and border length deliberately do **not** affect bonuses. Combat is classic 3v2 dice with ties going to the defender, so a large territory is no harder to take than a small one. Difficulty comes from how many territories must be defended. (Formula introduced in version 2; entry-point counting updated for natural frontiers in version 3.)

### 3.4 Determinism Rules (required for multiplayer)

- All randomness comes from `DeterministicRng` (a SHA-256 counter DRBG, `src/crypto/prng.ts`), seeded with `SHA256("MAP:v{version}:{seed}:{players}:{attempt}")`.
- Each phase uses its own `rng.fork(label)` stream (`sizes`, `noise`, `centers`, `grow`, `mainland`, `links`, `partition`, `names`), so tuning one phase doesn't reshuffle the others.
- Game-relevant math is **integer-only**: hex distances, integer noise, and cross-multiplied ratios. There's no `Math.sin/cos/sqrt` and no float comparisons that could differ between JS engines. Pixel geometry (`hexToPixel`, `hexCorners`) is render-only.
- Iteration order is always array or insertion order (never object-key or `Set` order derived from unordered sources).
- **Any change to the generator's output must bump `MAP_GENERATOR_VERSION`.** Old games store their version, so a client that can't reproduce that version must refuse the game rather than silently diverge.

### 3.5 Tuning Knobs (`MAP_TUNING`)

| Knob | Default | Effect |
|---|---|---|
| `landPercent` | 40 | Lower values mean more ocean and longer links (more sea lanes) |
| `continentSeparation` | 3 | Minimum land-to-land distance between continents |
| `maxBridgeDistance` | 4 | Gaps up to this become land bridges |
| `maxLinksPerContinent` | 3 | Fewer links mean scarcer, more contested chokepoints |
| `growthDistanceWeight` / `growthJitter` | 34 / 50 | Rounder blobs vs. lobed coastlines with peninsulas |
| `minHexesPerTerritory`..`maxHexesPerTerritory` | 5..7 | Territory size (affects tap-target size on phones) |

---

## 4. Classic Risk Ruleset Specification

### 4.1 Game Setup (`auto_deal_manual_troops`)
1. **Auto-Deal Territories**:
   - Using the initial game seed `SHA256(lobbyEventId + ":" + allInitialCommitments)`, shuffle the `T` territories deterministically and deal them round-robin to the `P` players.
   - Because `T` is a multiple of `P`, every player receives `T / P` territories, each initialized with `1` troop.
2. **Initial Troop Placement Phase (`SETUP_PLACEMENT`)**:
   - Each player has `remainingSetupTroops = startingTroopsPerPlayer - (T / P)`.
   - To keep relay traffic minimal, **Setup Placement happens in 1 batch per player** (or 2 rounds): each player assigns their remaining starting troops across their owned territories and submits a `SetupPlacementAction`.
   - Once all players have submitted their setup placements, Turn 1 begins.

### 4.2 Turn Structure (Classic Risk)
Every regular turn consists of three logical sections inside a single `TurnActionPlan`:

1. **Reinforcement (Draft) Phase**:
   - **Base Troops**: $\max(3, \lfloor \text{ownedTerritories} / 3 \rfloor)$.
   - **Continent Bonus**: Sum of `continent.bonus` for each continent where the player owns 100% of territories at the start of their turn.
   - **Territory Card Trade-In (Fixed Set Values)**:
     - Each territory card has a `territoryId` and an emblem: `'INFANTRY' | 'CAVALRY' | 'ARTILLERY' | 'WILD'`.
     - If a player holds **5 or more cards** at the start of their turn, they **must** trade in at least one valid 3-card set.
     - **Fixed Set Bonuses**:
       - `3x INFANTRY` = **+4 troops**
       - `3x CAVALRY` = **+6 troops**
       - `3x ARTILLERY` = **+8 troops**
       - `1x INFANTRY + 1x CAVALRY + 1x ARTILLERY` = **+10 troops**
       - (`WILD` cards can substitute for any emblem).
     - **Territory Match Bonus**: If the player owns the territory shown on any traded card, place **+2 bonus troops** directly onto that specific territory (max +2 per turn, or +2 on each matched territory).
   - All draft troops are placed on territories owned by the active player at the start of the turn.

2. **Attack Phase (Queued Campaign Orders)**:
   - The player specifies an ordered list of `AttackCampaignOrder` items:
     ```ts
     interface AttackCampaignOrder {
       id: string;
       fromTerritoryId: number;
       toTerritoryId: number;
       /** Stop attacking if attacker's troops on fromTerritoryId drop to or below this number (min 1) */
       stopWhenAttackerAtOrBelow: number;
       /** If toTerritoryId is conquered, how many troops to move into it (beyond the mandatory dice-count minimum) */
       occupyMode: 'MIN' | 'HALF' | 'ALL_BUT_ONE' | { fixedLeaveBehind: number };
     }
     ```
   - **Chained Attacks Supported**: A player can queue `A -> B` followed by `B -> C`!
     - During deterministic resolution, if `A -> B` succeeds and conquers `B`, troops move into `B` according to `occupyMode`.
     - Then the next order `B -> C` checks if the active player now owns `B` and has `> stopWhenAttackerAtOrBelow` troops; if so, it executes `B -> C`! If `A -> B` failed to conquer `B`, any subsequent order originating from `B` is safely skipped as a no-op.
   - **Friendly-Fire Guard**: If `toTerritoryId` is already owned by the active player when the order is reached, that order is skipped.
   - **Classic 3v2 Risk Dice Rules (per battle wave inside an `AttackCampaignOrder`)**:
     - Attacker rolls $\min(3, \text{attackerTroops} - 1)$ dice (`1..6`).
     - Defender rolls $\min(2, \text{defenderTroops})$ dice (`1..6`).
     - Sort both dice arrays descending. Compare highest vs. highest, and (if both rolled $\ge 2$ dice) second-highest vs. second-highest.
     - Ties go to the **defender** ($\text{attackerDie} > \text{defenderDie}$ -> defender loses 1 troop; otherwise attacker loses 1 troop).
     - Repeat waves until either `defenderTroops === 0` (conquered!) or `attackerTroops <= stopWhenAttackerAtOrBelow`.
   - **Card Award**: If the active player conquered **at least 1 territory** during their turn, they draw **1 card** from the deterministic shuffled deck at the end of the turn.
   - **Player Elimination**: If a defender loses their last territory, the attacker immediately receives all of the eliminated defender's territory cards. (In the Whole-Turn model, these cards can be traded on the attacker's next turn).

3. **Fortify Phase (`connected_path`)**:
   - The player may specify up to **1 `FortifyOrder`**:
     ```ts
     interface FortifyOrder {
       fromTerritoryId: number;
       toTerritoryId: number;
       troopCount: number; // or 'ALL_BUT_ONE' | 'HALF'
     }
     ```
   - **Validation during execution**: At the end of the Attack Phase, if the active player owns both `fromTerritoryId` and `toTerritoryId`, has `> 1` troop on `fromTerritoryId`, and there exists a **contiguous path of owned territories** connecting `fromTerritoryId` and `toTerritoryId` (verified via BFS on owned territories), move `min(troopCount, fromTroops - 1)` troops from `fromTerritoryId` to `toTerritoryId`.

---

### 4.3 Exact Engine Rules
The precise implementation rules are spelled out in [CHECKLIST.md](./CHECKLIST.md) steps 1.7–1.10, so that any model can implement them without making design decisions. They cover:
- RNG fork labels.
- Starting troops.
- Deck emblem assignment (cycling INF/CAV/ART over a seeded shuffle, plus 2 WILDs).
- WILD set valuation.
- One +2 territory match per traded set.
- The conquest move: minimum is the dice rolled in the final wave, maximum is troops − 1, and the occupy mode picks within that range.
- Skip reasons and fortify clamping.

Those rules are authoritative and extend this section.

**Turn-engine decisions (step 1.11, `src/engine/turnEngine.ts`):**
- **Mandatory trade:** with 5+ cards at turn start, the plan must trade until fewer than 5 remain. A hand of 5 or more always contains a valid set.
- **Cards won by elimination** this turn are traded next turn.
- **Commit-time validation versus runtime skips.** `validateTurnPlan` rejects anything wrong at commit time:
  - wrong turn or player;
  - card problems;
  - a draft that doesn't sum exactly to `base + continents + card sets` on owned territories (the +2 match troops are placed automatically);
  - malformed orders, or more than 64 attacks.

  Anything that depends on dice (chains, threshold stops) is a logged skip instead.
- **Resolution order:** verify the witness reveal → trades and the +2 match → draft → attacks in queue order → fortify → draw 1 card if anything was conquered. If the deck is empty, the discard pile is reshuffled with `turnRng.fork('reshuffle')`. Then check for a win, or advance to the next alive seat.
- **Dice** come from `DeterministicRng(SHA256(commitId:secret)).fork('dice')`.
- **A winning turn** ends immediately: no fortify and no card draw.

---

## 5. Nostr Protocol, Anti-Cheat RNG, & Multi-Relay Consensus

### Phase 2 implementation decisions (2026-11-02)

The owner selected **private invite-only, 2–8 human players, no bots**, preserving the current **interactive attack** experience. The whole-turn design below is historical reference, not the selected multiplayer gameplay. Multiplayer must not reuse LOCAL `interactiveSteps` after revealing one turn seed: that would let the attacker inspect dice before choosing later attacks.

**Current decision (2026-11-02): Nostr-only, responsive asynchronous play.** The owner rejected per-attack beacon delays and explicitly accepted modified-client cheating risk in exchange for good UX, no game/referee server and no external randomness API during new play. New games use `nostr-dice-v1`; beacon and witness protocols below are compatibility history, not the current default.

### Current Nostr-only dice and practical safeguards

- Player-facing navigation is **Multiplayer**. Normal screens guide hosting, approval, army placement and turns; seed commitment/reveal chatter and successful relay receipts are not gameplay notifications. Account keys, relay configuration, setup hashes and history tools are collapsed under settings/details. Delivery failures, conflicts, storage errors and retry actions remain visible.
- The multiplayer landing screen separates hosting/joining/resuming from a dedicated Create Account / Manage Account view. Without an account, Host Game and Join Game are greyed and marked `aria-disabled`, but handle activation to explain "You need an account first"; they never enter a lobby. Creating a local account or connecting an existing signer unlocks both.
- Landing-screen instructions and privacy/fair-play explanations are available through a keyboard/touch-accessible `?` disclosure, closed by default. Normal entry shows actions and saved-game/account context, not introductory paragraphs or automatic welcome notifications.
- Solo and Multiplayer menus share the same background/Neon Dominion heading markup, glass card styling and Solo/Multiplayer mode switch. Multiplayer retains account/host/join/resume actions instead of solo bot/map-generation controls.
- Multiplayer and Solo use shared `gamePhaseUi.ts` presentation helpers for starting deployment, draft/card tiles and trades, placement chips, ×1/×5/All controls, attack confirmation/Stop At, conquest movement (minus/plus/Set/Min/Max/Move), optional connected-map fortification (stepper/Clear/Back/Finish Turn), victory/elimination, commander badges/rosters, tapped-territory pills and continent intel. End-game statistics use the same `showGameSummary` modal/table. The setup board is mounted outside the menu card, just like live play, and uses the same responsive map/HUD/sheet/intel layout. There are no separate numeric setup/draft forms or fortification dropdowns.
- Attack selection is map-first without automatically choosing a target. Selecting an adjacent enemy opens the shared army total, Stop At toggle/minus/input/plus/Off palette and Cancel/Confirm Attack row. Stop At counts attackers only; repeated activation does not turn it off, and only Off disables it. Multiplayer's signed session/rule pipeline remains separate from Solo's transport: no bot turns are invoked, draft/trade Undo affects only unpublished edits, movement bounds remain enforced, and Finish Turn signs the optional fortification once. Async waiting/connection failures and retry tools remain available without showing protocol chatter during normal play.
- Fortify's shared minus/count/plus controls include MAX in both modes. MAX selects all source troops except the one reserved army; it edits the planned move without executing it or ending the turn.
- Saved account names override that identity's labels locally in game descriptions, lobby/setup rosters, the gameplay HUD and statistics. Saving refreshes My Games immediately; unsaved form edits are not used when opening a saved game. Signed roster/setup/player names remain immutable for deterministic replay, and local account renames are not broadcast to other commanders.
- The first commander signs `play-dice-start` referencing the fully deployed state. No additional all-player ready barrier is required. Each active player can finish their whole turn while everyone else is offline.
- Each attack contains a fresh CSPRNG 32-byte `diceNonce`. The client durably saves the complete exact timestamped template before signing and the verified signature before accepting the action locally. Its seed is `deriveTurnSeed(eventId, SHA256("neon-dominion-nostr-dice-v1:" + eventId + ":" + diceNonce))`; the existing deterministic `dice` stream resolves every wave immediately during signed-history replay. There is no future-round timer, remote dice provider, witness secret, or claimed dice array to trust. Extension signing latency still applies, but relay acknowledgment does not delay individual attacks.
- **End-of-turn publication:** normal `nostr-dice-v1` draft/trade/attack/move actions are saved in an identity/game-scoped durable outbox and replayed locally without relay writes. Finish Turn saves the signed end action and a publishing marker before sending the existing events in predecessor order; a winning conquest movement flushes automatically because it has no subsequent Finish Turn. This is a batch of existing signed events, not a new whole-turn event format or an atomic relay transaction. Lobby/setup, dice genesis/upgrades and pending legacy witness/beacon actions retain their immediate publication.
- Retry, reload, duplicate delivery, interrupted signing and lost acknowledgments reuse the original nonce/template/event and therefore the same outcome. A durable action slot refuses alternate decisions. The outbox survives an ordinary cache loss and restores local progress after fetching the published baseline. Once a local turn has started it can continue through a disconnect; beginning a new turn still requires relay catch-up. Completed batches block new actions until sent. On partial delivery/reload, retry resends the entire original batch (duplicates are harmless); the outbox is cleared only after all events are acknowledged and that completion is saved. Storage failures/corrupt queues/concurrent changes are surfaced instead of discarding progress. Every client verifies signatures, active author, predecessor/state hashes, exact reinforcements, legal attacks/movement/cards, and recalculates dice. Conflicting signatures at an action index halt visibly with history retained.
- These are casual anti-reroll safeguards, **not cheat-proof randomness**. A modified client can simulate/grind nonce/event choices before publishing, erase private bindings, withhold unfavorable unpublished history, or collude. The owner selected end-of-turn publication knowing that opponents cannot observe attacks during a turn and that it removes the public record of individual results before the turn is finished. Signatures establish authorship and replay consistency, not unbiased choices or trustworthy publication time. No obfuscation or disabling browser developer tools is claimed as protection. Play with trusted friends.
- Existing games automatically sign an irreversible `nostr-dice` action at the active player's current index, preserving armies, cards, phase, turn and statistics. Durable outstanding actions are recovered first. An already locked beacon attack retains its original round/result and completes once before migration; it is never rerolled. An unresolved legacy witness attack retains its selected action and uses the existing beacon migration once, then switches. Old beacon/witness proofs remain locally replayable; refreshed clients are required for new protocol events.
- Validation covers complete offline-opponent turns, zero relay writes during local turns, deterministic catch-up, nonce/signature tampering, illegal actions, forks, corrupt/foreign queues, storage/concurrent-write failures, partial-batch retry/reload, acknowledgment-save failure and legacy migration without resetting or rerolling existing attacks. Browser validation additionally completed a full game and verified automatic victory publication and matching opponent replay.

### Earlier beacon/witness implementation (compatibility reference)

**Earlier asynchronous correction (2026-11-02):** public drand beacon-only dice replaced the initial live witness requirement. The owner subsequently rejected its 10–12-second attack wait. Its verifiable randomness and migration schemas remain supported solely for existing history/pending attacks; a beacon never proved when an attack was published.

- **Identity foundation implemented:** the NOSTR menu connects to a NIP-07 browser signer or explicitly creates a dedicated guest key. On returning, an existing guest is restored automatically; a fresh key is never generated automatically. Guest signing keys stay in `nd.nostr.guest.v1` in origin-local browser storage, separate from solo saves and hash-chain roots. `nd.nostr.login.v1` remembers the selected login method or explicit disconnect; extension/NSEC selection never silently falls back to a saved guest. Older guest saves without a login preference also restore. Keys are unencrypted and intended only for low-value game identities; deleting site data loses them. Signer permission errors never silently select a guest. Disconnect keeps a guest key but suppresses automatic login; forgetting it requires confirmation. Extension login still requires user permission; imported NSEC persistence requires explicit opt-in. The Multiplayer menu also synchronizes public profiles, invitations and game history with shared relays after login.
- **Signing:** `src/nostr/identity.ts` checks the returned pubkey, exact event template, event ID and signature, without trusting the signing library's verification cache. Identity tests cover signatures, altered events, wrong identities, permission rejection, persistence and storage errors.
- **NSEC import:** a third login option accepts a pasted NIP-19 `nsec` in a masked input. It validates the checksum and private scalar and clears the input on every import attempt. Imports are memory-only by default. An unchecked-by-default **Remember on this device** option stores the validated NSEC unencrypted at `nd.nostr.nsec.v1`; `restoreLogin` restores it only when the explicit login preference is `nsec`, never falling back to another saved identity. Disconnect removes the remembered NSEC; importing without remembering or selecting another login method removes any previous remembered import. Device-created guest keys retain their separate storage and restoration behavior. Decoder errors are replaced with a fixed message so private input cannot appear in errors. Prefer extension signing and dedicated game keys; plain HTTP LAN connections are not suitable for valuable private keys.
- **Commander names:** `src/nostr/profile.ts` derives a stable adjective/noun/number name from a domain-separated hash of the full public key. The connected identity screen allows a 1–32-character custom name and resetting to the generated name. Overrides are stored per pubkey in origin-local storage; failures are shown explicitly. Names are not unique identities and do not update a public Nostr profile. Signed lobby creation/join events carry validated display names, rendered as text alongside public identities. A name is fixed for that request; leave/rejoin to change it.
- **Interactive turns implemented:** draft/trades are signed first. Every decision has a monotonically increasing global action index and previous-action/state references. In beacon mode an attack binds source, target, dice/stop settings and one future quicknet round. Dice use `DeterministicRng(SHA256(commitId:verifiedRandomness)).fork('dice')`, never local whole-turn randomness. Conquest movement, fortification/end-turn and mandatory captured-card trades are signed and validated. Captured hands of 5+ cards must trade/place before further attacks/end-turn. Full-map victory occurs after mandatory conquest movement, without a final card draw.
- **Setup implemented:** the host freezes the approved human roster and immutable relay list. Each selected commander contributes a seed and deploys once, at their own convenience; simultaneous presence is unnecessary. Automatic reveals wait for all commitments. The initial active commander initializes asynchronous play after all deployments, without another all-player ready barrier. Extension signing refusals pause visibly with retry controls.
- **Disconnect baseline:** an offline opponent never blocks beacon attacks. The current player can finish/end a turn, close the game and let the next commander catch up later from signed history. Initial setup still waits for each contribution/placement. Beacon/relay outages pause publication or the exact locked attack; there are no automatic skips, substitutes, forfeits or fallback dice.
- **Equivocation baseline:** conflicting signed actions/legacy ready/reveals and migration locks halt with proof retained. Neither relay timestamps nor first arrival choose a fork. Automatic reconciliation, separate proof-publication events and adversarial multi-relay integration remain deferred.
- **Trust limitation:** drand signatures establish authentic round randomness, not when a Nostr attack was published. Local durable locks enforce honest-client behavior but cannot stop modified clients backdating attacks, withholding an unfavorable attack before publication, or colluding. The owner accepted this friends-only trade-off rather than deploying a signed-lock service.
- **Legacy chain capacity:** the earlier witness mode used **8,192 secrets per commander**. Its heads/reveals are retained only to replay old games. Beacon mode does not consume player secrets and has no witness-chain exhaustion. Automatic renewal remains unimplemented/unneeded for new turns.
- **Privacy and scope:** invite-only is access control, not encryption. Signed gameplay on shared relays is public. Remote signers (NIP-46), bots, public matchmaking and automatic forfeits are outside the first playable milestone.

**Current boundary:** identity, host-approved lobbies, automatic map preparation, manual initial deployment, and synchronized interactive multiplayer turns through victory are implemented. The multiplayer board never creates a `LocalGame`, starts bots or enables local-only attacks. Existing solo gameplay remains isolated in `LocalGame`. Public-relay/physical-device gameplay, real-extension permission UX and adversarial multi-relay testing remain release follow-ups.

### Playable signed turns and recovery

- [beacon.ts](./src/nostr/beacon.ts) pins drand quicknet chain `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`, public key, genesis and 3-second period. The locked round is the first round strictly after `created_at + 9 seconds` (10–12 seconds for integer timestamps). The API mirrors receive only the public chain/round, never game data or keys. BLS12-381 short signatures verify locally using `@noble/curves`, RFC9380 G1 hashing and the pinned key; the message is SHA256 of the uint64 big-endian round. Randomness is SHA256 of signature bytes. Mismatched rounds/randomness, malformed signatures and outages fail explicitly. Mirrors may change availability but cannot supply different valid dice.
- [playProtocol.ts](./src/nostr/playProtocol.ts) extends the existing version-1 envelope with `play-beacon-start` (first commander's signed deployed hash and pinned chain), `play-beacon` (signed publication of a verified round/signature bound to an attack/index), and `play-beacon-lock` (migration of an already pending legacy attack). All signatures are retained for offline replay. Legacy `play-ready`/`play-reveal` events still replay unchanged.
- `play-action` includes `start`, `index`, `prev`, `stateHash`, a validated decision, and `beaconRound` for beacon attacks. The snapshot hash includes phase, pending movement, reward flag, round, statistics and beacon mode. An attack remains pending until its matching BLS proof is published; its round cannot change on retry, outage or reload. Any roster member can relay a proof; duplicate equivalent proofs use a canonical resolution ID independent of publisher/event timestamp, so they cannot fork state. Offline replay verifies proofs locally, without another API request.
- **Existing games:** the active player automatically signs an irreversible `beacon` decision at the current action index; armies, cards, phase, turn and statistics remain intact. For an already pending legacy attack, the original attacker signs a durable `play-beacon-lock` for a future round without changing the original attack. Resolution permanently switches to beacon mode. Refresh old clients before migrating: competing legacy witness and beacon migration resolutions halt visibly rather than rewrite previously applied actions. Games with partial legacy ready commitments but no actions can initialize beacon play directly from the deployed state.
- Pure replay buffers later actions until predecessors exist, ignores non-roster gameplay authors, deduplicates IDs, and halts authenticated illegal actions, state/predecessor mismatches and signed forks. Eliminations transfer cards, change the next living witness/turn, and retain statistics. One real deck card is awarded per non-winning turn with a conquest. Empty-deck reshuffles use a domain-separated deterministic seed from the signed end-action ID.
- [lobbySession.ts](./src/nostr/lobbySession.ts) persists exact timestamped templates **before signing**, then verified events **before publishing**, in `nd.nostr.play-sign.v1.<lobbyId>.<pubkey>.<slot>`. An index never accepts an alternate decision; interrupted signing, lost acknowledgment, clock changes and reload reuse the original timestamp, round and signature. Reconnect recovers outstanding local actions from bindings if the ordinary cache lost them. Legacy roots in `nd.nostr.play-root.v1.<lobbyId>.<pubkey>` remain private and are unnecessary after migration. Use one tab per identity; local-storage checks are not cross-device locks or trusted publication timestamps.
- The signed-history safety limit is 250,000 records rather than the old 2,000-event lobby-only limit. Browser storage can fill sooner: save/signing failures are visible; private-binding write failures stop publication. Keep site data and original identity, and export signed history when needed. Export contains public signed events/revealed contributions, not unrevealed witness roots.
- [multiplayerBoard.ts](./src/ui/components/multiplayerBoard.ts) provides reinforcement/card trades, source/target selection or map taps, attacker dice and Stop At counting attackers only, conquest movement, fortification/end-turn, battle results, winner/statistics and history export. It automatically initializes/upgrades beacon mode and resolves future rounds while opponents are offline. Fetches cancel on exit; errors expose retry without selecting a new round. Human selections never move the camera. **NOSTR → Resume Game** catches up from signed history without another approval.

### Host/Join lobby milestone

- **Cross-site recovery:** [gameDiscovery.ts](./src/nostr/gameDiscovery.ts) searches shared default relays for the account's authored lobby events in bounded pages, fetches referenced signed creations, and retrieves each discovered game's history (up to the game history limit). Only hosted games or games with a validated join chain/membership for the account are saved. It merges with the latest local cache and preserves pending actions, stops writes on logout/screen exit, and reports relay failures, skipped malformed events, scan limits and custom-relay-only games. My Games triggers discovery automatically and provides a manual sync button. This recovers public game history, not private setup secrets, signing bindings, hash-chain roots or unpublished turns; those remain origin-local.
- **Use:** connect any supported identity, choose **Host Game**, select a maximum of 2–8 players including the host, and pick 1–7 accepted friends within capacity. Create Game & Invite Friends publishes the invitation on the shared default relays. Recipients open Multiplayer and choose **Accept Invitation & Join** to take their seat automatically, without host approval or the host being online. The host can start with at least two commanders, even below maximum capacity. Existing games without a friend invitation list retain code-sharing and host approval.
- **Protocol:** [lobbyProtocol.ts](./src/nostr/lobbyProtocol.ts) defines regular NIP-01 kind `1042` events with `t=neon-dominion-lobby-v1`. Creation has a random nonce, host name, capacity and immutable relays; its signed event ID identifies the lobby. New games also include immutable `invited` entries containing each friend's pubkey and two signed friendship events proving mutual acceptance, plus matching `p` tags for invitation discovery. Creation size is bounded at 32 KiB. Only those identities' valid sequential join/leave chains (`seq`, `prev`) can contribute seats; active acceptances are admitted automatically in pubkey order after the host, and start freezes exact signed acceptance references. The number of invitees cannot exceed capacity minus one. Friendship is checked as a signed snapshot at invitation time, not continuously revoked afterward. Legacy games keep the host's approval-ordered roster chain. The host signs a sequential closure/start chain in both modes. The same channel carries setup and interactive gameplay messages.
- **Validation:** event signatures are checked afresh without verification-cache symbols. Creation must match the invite's exact ID, host and relays. Names, field sizes, capacity, author permissions and roster references are checked. Duplicates are ignored, out-of-order history is buffered and recomputed, and timestamps never select between competing signatures. A host roster fork halts the lobby with both events retained. Conflicting applicant chains exclude that applicant rather than letting an unapproved outsider halt everyone else. Missing dependencies prevent the affected signer from branching their own history.
- **Relays:** [lobbySession.ts](./src/nostr/lobbySession.ts) uses `nostr-tools`' pool, explicitly subscribing per relay to both creation and lobby updates. Actions wait for genuine end-of-stored-events (EOSE) history, not the library's synthetic timeout EOSE. A relay history timeout closes that stream with a visible error; connection/history failures remain visible. At least one complete, connected relay is required, with every configured relay attempt settled. This is a partial-availability baseline, not Byzantine consensus or proof that a relay supplied complete history.
- **Acknowledgments/retry:** publishing waits for all relay outcomes. At least one acknowledgment is required to clear the pending action; partial delivery is explicitly reported. If none acknowledge, keep and retry the exact signed event ID, never a new signature or branch. Automatic incremental resubscription is disabled: **Reconnect / Refresh History** requests full history, avoiding timestamp-based gaps between same-second events.
- **Reconnect/storage:** [nostrLobby.ts](./src/ui/screens/nostrLobby.ts) stores each game's invite, validated signed history and pending event in the identity-scoped collection `nd.nostr.games.v1.<pubkey>`, without identity keys or unrevealed witness roots. [savedLobby.ts](./src/nostr/savedLobby.ts) revalidates cached signatures, invite binding and pending author for the menu/reconnect path. **Multiplayer → My Games** lists all saved games, most recently opened/updated first, with a short game identifier, commander names and cached lobby/setup/turn/victory status. Open Game passes the selected game ID through the router and catches up directly without Host/Join, another invite, join signature or approval. Reopening an existing invite restores that game's cache instead of replacing its pending history. The old `nd.nostr.lobby.v1.<pubkey>` save is included automatically and copied into the collection on the next save; the original is retained, and duplicate game IDs are not listed twice. New games never replace other games. Per-game setup, signing bindings and unpublished-turn outboxes keep their existing game/identity-scoped keys. Storage is browser/origin-specific; use the same site address after closing a page. An invite also permits relay-only catch-up. Back disconnects without releasing a seat; before start, **Leave Lobby** releases it and **Close Lobby** is host-only/terminal. Storage/identity failures remain visible. Signed history can be downloaded; the shared gameplay safety limit is 250,000 records per game, although browser storage quotas may be reached sooner.
- **Testing scope:** protocol/session and relay-adapter tests cover ordering, signatures, permission/capacity checks, forks, lost acknowledgments, exact-event retry, history timeout and connection cleanup. Two independent browser origins/identities were exercised through a real temporary local WebSocket relay for hosting, shared names, approval, leaving, reapproval and reload/reconnect. Public-relay policy/retention, real NIP-07 devices and physical two-device testing remain integration checks. Use `wss://` publicly; `ws://` is only for trusted local testing and may be blocked from HTTPS pages.

### Start Game and synchronized setup milestone

- **Roster lock:** a host-signed `start` message extends the existing host roster chain (`seq`, `prev`), selects only previously approved join requests, and pins `MAP_GENERATOR_VERSION`. It requires 2–8 total commanders and is terminal for lobby membership/closure changes. Later leave/join events cannot change its frozen seats. A competing start/roster/closure at the same chain position halts with proof retained. Selected commanders with conflicting join chains halt setup rather than silently reverting to an earlier lobby state.
- **Seed commitments:** each selected commander's connected client automatically contributes after receiving the host's signed start and completed relay history. A fresh cryptographically random 32-byte contribution is durably stored before any signature/publication. `seed-commit` signs `SHA256("neon-dominion-setup-commit-v1:" + startEventId + ":" + pubkey + ":" + secret)` and references the exact start. The initial start never signs on anyone else's behalf. Permission/storage errors show **Retry Preparation** rather than silently proceeding.
- **Reveal barrier:** automatic `seed-reveal` runs only after every locked commander has committed. It includes the contribution and exact commitment event IDs in locked seat order. Every client verifies those references and commitment hashes. Missing players pause the process; no host-only fallback seed, bot replacement, timeout skip or re-roll exists. A participant can still stall by withholding their contribution; this is not Byzantine consensus.
- **Map/deal:** [setupProtocol.ts](./src/nostr/setupProtocol.ts) derives a domain-separated SHA-256 seed from canonical JSON containing the start event ID and all contributions in seat order. Existing `generateMap` and `createGame` deterministically create geometry, ownership, troop pools and deck with public keys/names as human players. The full initial state hash is shown on both clients. Generation failures halt explicitly rather than choosing a replacement seed. Map generation is cached by the agreed seed.
- **Deployment:** [multiplayerSetup.ts](./src/ui/components/multiplayerSetup.ts) provides a setup-only shared map, manual pan/zoom, tap-to-add and labeled numeric inputs for owned territories. Local edits survive incoming remote updates but reset on reload until signed. **Deploy Initial Armies** signs `setup-deploy` with the start ID, original deal hash and unique sorted extra-army placements. Every client checks exact troop total/ownership and applies submissions in locked seat order, not relay arrival order, to produce identical final state/hash. Deployed armies survive reload. Selection/deployment never refits/reorients the camera; only initial map creation, actual viewport orientation changes or explicit Fit Map do.
- **Persistence/recovery:** `nd.nostr.setup.v1.<lobbyId>.<pubkey>` contains the unencrypted private setup contribution and exact signed start/commit/reveal/deployment bindings (as applicable). This is separate from signed lobby history and never included in an export. Revealing intentionally makes only that setup contribution public; it is not an identity key or future attack RNG secret. Losing the contribution after commitment cannot be repaired with a new one. Storage failures stop the setup action before publication. Restoring/retrying uses the original signed event IDs, and **Resend My Saved Setup Events** rebroadcasts dependencies in order without new signatures. Clearing site data or changing origin before reveal can strand setup.
- **Validation:** outsiders' seed/placement events cannot affect a locked game. Multiple signatures for one participant's setup step, wrong commitment references/reveals and invalid signed deployments halt setup. Messages can arrive duplicated or out of order; full signed-history replay regenerates the same map and final hash. Tests exercise two, three and eight humans, even deals/troop pools, version/authorization checks, storage errors, missing secrets, lost acknowledgments, immutable placement bindings and forks. Real local-relay browser checks cover both players' Start/Commit/Reveal/Deploy flow, reload before reveal and after deploy, matching hashes, phone layout, tap placement and stable camera/geometry through deployment.
- **Gameplay transition:** after all deployments, the first commander's `play-beacon-start` binds the fully deployed state and pinned quicknet chain, and the separate playable board starts automatically. No witness-ready barrier, map reset or local-only turn engine is involved. Legacy ready/turn histories can upgrade as described above.

This section directly solves the two hardest problems in a serverless Nostr strategy game:
1. **How do we prevent a player from simulating their turn locally, seeing bad dice rolls, and reversing/modifying their turn before publishing?**
2. **How do we prevent a player from publishing different turns to different Nostr relays (split-brain / equivocation) or rolling back turn numbers?**

### 5.1 Pre-Committed SHA-256 Hash Chains (Zero Extra Handshakes)

When a player joins a match lobby (`GameJoinEvent`), their client generates a random 32-byte root secret $S_N$ (stored locally in `localStorage` / IndexedDB and optionally encrypted to self via NIP-44 for backup) and hashes it $N = 500$ times:
$$S_k = \text{SHA256}(S_{k+1}), \quad C_0 = S_0 = \text{SHA256}^N(S_N)$$

The player publishes $C_0$ (the head of their hash chain) in their `GameJoinEvent`.
- To reveal secret #1, the player publishes $S_1$. Everyone verifies $\text{SHA256}(S_1) === C_0$ in $<0.01\text{ms}$, and updates that player's commitment head to $C_1 = S_1$.
- **Why this is huge**: Nobody can ever forge or alter their future seed reveals—their entire sequence of secrets $S_1, S_2, \dots, S_N$ was cryptographically locked before the game even started!
- **Implementation** (`src/crypto/hashChain.ts`):
  - Each link is `SHA256(raw 32 bytes)`, never the hex text, and all values are canonical lowercase 64-char hex.
  - The owner uses a `HashChainCursor`. Persist `{ root, length, used }` and rebuild the chain on load (500 hashes takes a few milliseconds).
  - Verifiers accept only the next secret in order: `SHA256(secret) === currentHead`.

### 5.2 The 2-Event Whole-Turn Commit-Reveal Lifecycle

Suppose it is **Turn $T$**, and **Player $A$** is the active player. **Player $B$** is the next alive player in turn order (the designated **Turn Witness / Seed Revealer** for Turn $T$).

```text
Player A (Active Player)                 Nostr Relays                 Player B (Next Alive Player)
------------------------                 ------------                 ----------------------------
1. Plans Draft + Attack Queue + Fortify
   (Does NOT know Player B's secret S_B)
2. Signs & broadcasts TurnCommitEvent ───► [Kind 30777 / 4333] ──────► 3. Verifies TurnCommitEvent:
   - turnNumber: T                                                        - turnNumber === T
   - prevStateHash: H(State_{T-1})                                        - prevStateHash matches local state
   - actionPlan: { ... }                                                  - actionPlan is legal
                                                                       4. Signs & broadcasts TurnRevealEvent:
                                         ◄─ [Kind 4334] ──────────────    - commits to: turnCommitEvent.id
                                                                          - reveals: S_B (where SHA256(S_B) == C_B)
5. All clients receive TurnRevealEvent:
   - Verify SHA256(S_B) === C_B
   - Compute TurnSeed = SHA256(turnCommitEvent.id + ":" + S_B)
   - Run applyTurn(State_{T-1}, actionPlan, TurnSeed) -> State_T
   - Verify newStateHash === H(State_T)
   - Play Battle Replay Animation!
   - Now it is Player B's turn (Turn T+1)!
```

#### Why Local Scumming is Mathematically Impossible:
1. **Can Player $A$ test different attack plans locally first?**
   - **No.** Player $A$ does not have $S_B$. Even if Player $A$ changes a single troop placement in their `TurnCommitEvent`, `turnCommitEvent.id` (which is the SHA-256 hash of the Nostr event) changes completely, which would also change `TurnSeed = SHA256(turnCommitEvent.id + ":" + S_B)`. Player $A$ is 100% blind to the dice rolls until after `TurnCommitEvent` is signed and broadcast.
2. **Can Player $B$ look at Player $A$'s `TurnCommitEvent` and pick a seed $S_B$ that makes Player $A$ lose?**
   - **No.** Player $B$'s secret $S_B$ is locked by $\text{SHA256}(S_B) === C_B$, which Player $B$ committed to at the start of the game. Because SHA-256 is preimage-resistant, Player $B$ has **only one valid string $S_B$** in the universe that satisfies $\text{SHA256}(S_B) === C_B$.
3. **What if Player $A$ sees bad dice after Player $B$ reveals $S_B$, and tries to "undo" or publish a new `TurnCommitEvent`?**
   - **Impossible.** Player $B$ has already revealed $S_B$ linked to the original `turnCommitEvent.id` and advanced to Turn $T+1$. Every client's state machine locks Turn $T$ as soon as a valid `(TurnCommitEvent, TurnRevealEvent)` pair exists.

### 5.3 Multi-Relay Split-Brain & Equivocation Protection

What if a malicious Player $A$ connects to Relay 1 and Relay 2 simultaneously and publishes `TurnCommitEvent_X` (attacking North) to Relay 1, and `TurnCommitEvent_Y` (attacking South) to Relay 2 for the same `turnNumber: T`?

Our architecture enforces **Three Layers of Defense**:

#### Defense 1:Strict Hash-Chained State (`turnNumber` + `prevStateHash` + `prevRevealEventId`)
Every `TurnCommitEvent` must include:
- `turnNumber: T` (strictly `lastTurn + 1`; any event with `turnNumber <= currentTurn` is ignored as historical/stale).
- `prevStateHash: string` (exact SHA-256 of canonical `GameState` after Turn $T-1$).
- `prevRevealEventId: string` (the Nostr `event.id` of Turn $T-1$'s seed reveal).

This makes it impossible for a relay with missing or old events to cause a client to "go backward" in time. If a client sees a turn number higher than its local state, it queries its relay pool for the missing `turnNumber` events and validates the unbroken hash chain from Turn 0 -> Turn $T$.

#### Defense 2: Witness Quorum Check Before Reveal
Before Player $B$ (the witness for Turn $T$) publishes `TurnRevealEvent`, Player $B$'s client:
1. Waits a brief relay propagation window (`1500ms`) across all configured game relays (e.g., 3–5 relays specified in the lobby event).
2. Queries all connected game relays for any `TurnCommitEvent` from `Player A` for `(gameId, turnNumber: T)`.
3. **Case 1 (Honest)**: All relays that have the event return the exact same `turnCommitEvent.id`. Player $B$ rebroadcasts `TurnCommitEvent` to any lagging relay in the pool (ensuring 100% relay convergence) and publishes `TurnRevealEvent` referencing `["e", turnCommitEvent.id]`.
4. **Case 2 (Equivocation Detected — Cheater Caught!)**: Player $B$ (or any player) sees **two different validly signed `TurnCommitEvent` IDs** (`id_1 !== id_2`) signed by Player $A$'s Schnorr public key for the exact same `(gameId, turnNumber: T)`.

#### Defense 3: Cryptographic Proof of Equivocation (Self-Verifying Slash/Penalty)
Because every Nostr event is signed by the author's private key (`sig` over `id`), two different `TurnCommitEvent` objects with the same `(pubkey, gameId, turnNumber)` and `id_1 !== id_2` form a **self-contained, undeniable `EquivocationProof`**.
- Any client that observes both events bundles `{ commitA, commitB }` into a `TurnEquivocationEvent` and broadcasts it to all relays.
- **Deterministic Engine Rule for Equivocation**:
  - Option 1 (**Strict Forfeit / Skip Turn**): If an `EquivocationProof` is presented before Turn $T+1$ commits, Player $A$'s Turn $T$ is voided into a **No-Op Pass** (or automatic elimination).
  - Option 2 (**Canonical Tie-Break**): If `TurnRevealEvent` already bound to `commitA`, `commitA` is canonical because `TurnRevealEvent` is signed by Player $B$ and explicitly tags `commitA.id`. Because Player $B$ only reveals their single hash-chain secret once for `commitA.id`, `commitB` can **never** get a valid `TurnRevealEvent`!

> **Key Takeaway**: Because a `TurnCommitEvent` cannot execute without the next player's `TurnRevealEvent`, and the next player's `TurnRevealEvent` cryptographically binds to **one specific `turnCommitEvent.id`**, split-brain across relays is impossible! Even if Relay 2 initially only had `commitB`, as soon as Player $B$ broadcasts `TurnRevealEvent` (which embeds or re-broadcasts the winning `commitA`), every client follows the single branch that has both signatures (`Player A`'s commit + `Player B`'s reveal).

### 5.4 Open Protocol Issues (resolve before Phase 2; none block single-player)

1. **Witness stalling:** the next player can refuse to publish `TurnReveal` and freeze the game. Fix: add a reveal deadline (for example, 24 h async or 2 min live). After it expires, fall back to the next alive player's chain secret, and record a strike or auto-skip for the staller.
2. **Witness collusion:** Player B knows their own future secret $S_B$ in advance, so B could leak it to A. A could then grind turn plans offline until the dice look good. Fix options: derive `TurnSeed` from reveals by **all other alive players** (costs more events per turn), or by two witnesses (next player plus a rotating second). Two-player games are unaffected because the witness is the only opponent.
3. **Map seed and deal grinding:** if the host picks `mapSeed`, or the last joiner picks a `C_0` after seeing everyone else's, they can bias the map or deal. Fix: derive `mapSeed` and the deal seed from a two-round setup commit-reveal (`H(r_i)` from everyone, then reveal `r_i`), and never from values a single player controls. Single-player mode keeps the menu's random seed (§9.3).
4. **Hash-chain exhaustion:** a 500-step chain is only consumed when a player is witness, so it covers long games. Still, define a `CHAIN_ROTATE` event that publishes a new `C_0` signed under the old chain head.

---

## 6. Core TypeScript Data Models

> **As implemented (step 1.6).** The authoritative types are in [`src/types/game.ts`](./src/types/game.ts) and [`src/types/actions.ts`](./src/types/actions.ts). They differ from the listings below in these ways:
> - **`GameState.territories` is an array** indexed by territory id (`TerritoryState { owner, troops }`), not a `Record`.
> - **Players are referenced by seat index** (`PlayerIndex = number`) everywhere inside state and actions (`owner`, `activePlayerIndex`, `winnerIndex`, `plan.playerIndex`). `PlayerState.id` carries the stable identity (later a pubkey).
> - **The map isn't stored in state.** Clients regenerate it from `(mapSeed, players.length, mapGeneratorVersion)`.
> - `PlayerState` gains **`setupTroops` / `setupDone`** and drops `color`, which is a UI concern derived from the seat index.
> - **`GamePhase` is now `SETUP_PLACEMENT | ACTIVE_TURN_COMMIT | GAME_OVER`.** Lobby and reveal-waiting are transport states, not engine states.
> - **The deck's top card is the last element.**
> - **Resolution logs use typed skip reasons**, and `FortifyResolution` and `ReinforcementBreakdown` are named types.

Opus 5.5 should implement these exact data contracts in `src/types/`.

### 6.1 `src/types/game.ts`

```ts
export type PlayerId = string; // In local mode: "player-0", "bot-1"; in Nostr mode: hex pubkey
export type TerritoryId = number;
export type ContinentId = number;
export type CardEmblem = 'INFANTRY' | 'CAVALRY' | 'ARTILLERY' | 'WILD';

export interface AxialCoord {
  q: number;
  r: number;
}

// Implemented in src/types/game.ts. Pixel geometry and SVG paths are derived by the renderer, not stored.
export interface Territory {
  id: TerritoryId;
  name: string;
  continentId: ContinentId;
  hexes: AxialCoord[];             // includes any land-bridge hexes assigned to this territory
  labelHex: AxialCoord;            // medoid hex; troop badge position
  neighbors: TerritoryId[];        // land borders + bridges + sea lanes, sorted
  seaLaneNeighbors: TerritoryId[]; // subset reached only by sea lane
}

export interface Continent {
  id: ContinentId;
  name: string;
  bonus: number;
  territoryIds: TerritoryId[];
}

/** Narrow connections between landmasses, in addition to natural mainland borders. */
export interface Chokepoint {
  kind: 'BRIDGE' | 'SEA_LANE';
  a: TerritoryId;
  b: TerritoryId;
  from: AxialCoord;
  to: AxialCoord;
  bridgeHexes: AxialCoord[];       // BRIDGE only; already included in territories a/b
}

export interface GameMap {
  generatorVersion: number;
  seed: string;
  playerCount: number;
  attempt: number;                 // which deterministic retry produced the map
  territories: Territory[];
  continents: Continent[];
  chokepoints: Chokepoint[];
}

export interface TerritoryCard {
  id: number;
  territoryId: TerritoryId | null; // null for WILD cards
  emblem: CardEmblem;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: string;
  isBot: boolean;
  eliminated: boolean;
  cards: TerritoryCard[];
  /** Current head of this player's SHA-256 hash chain C_k */
  currentHashCommitment: string;
  /** How many reveals this player has consumed from their chain */
  hashChainIndex: number;
}

export type GamePhase =
  | 'LOBBY'
  | 'SETUP_PLACEMENT'
  | 'ACTIVE_TURN_COMMIT'
  | 'ACTIVE_TURN_REVEAL'
  | 'GAME_OVER';

export interface TerritoryState {
  ownerId: PlayerId;
  troops: number;
}

export interface GameState {
  gameId: string;
  version: 1;
  mapSeed: string;
  phase: GamePhase;
  turnNumber: number;
  activePlayerIndex: number;
  players: PlayerState[];
  territories: Record<TerritoryId, TerritoryState>;
  deck: TerritoryCard[];
  discardPile: TerritoryCard[];
  winnerId: PlayerId | null;
  prevStateHash: string;
  lastCommitEventId: string | null;
  lastRevealEventId: string | null;
}
```

### 6.2 `src/types/actions.ts`

```ts
import { PlayerId, TerritoryId } from './game';

export interface SetupPlacementAction {
  type: 'SETUP_PLACEMENT';
  playerId: PlayerId;
  /** Map of TerritoryId -> additional troops placed during setup (must sum to player's setup pool) */
  placements: Record<TerritoryId, number>;
}

export interface CardTradeOrder {
  cardIds: [number, number, number];
}

export interface DraftPlacementOrder {
  territoryId: TerritoryId;
  troops: number;
}

export type OccupyMode =
  | { type: 'MIN' }
  | { type: 'HALF' }
  | { type: 'ALL_BUT_ONE' }
  | { type: 'LEAVE_BEHIND'; leaveTroops: number };

export interface AttackCampaignOrder {
  orderId: string;
  fromTerritoryId: TerritoryId;
  toTerritoryId: TerritoryId;
  /** Stop rolling further waves if attacker troops on fromTerritoryId <= this threshold (minimum 1) */
  stopWhenAttackerAtOrBelow: number;
  occupyMode: OccupyMode;
}

export interface FortifyOrder {
  fromTerritoryId: TerritoryId;
  toTerritoryId: TerritoryId;
  troops: number;
}

export interface TurnActionPlan {
  type: 'TURN_ACTION_PLAN';
  turnNumber: number;
  playerId: PlayerId;
  cardTrades: CardTradeOrder[];
  draftPlacements: DraftPlacementOrder[];
  attackQueue: AttackCampaignOrder[];
  fortify: FortifyOrder | null;
}

/** Detailed log produced by deterministic turn resolution for animated UI playback */
export interface DiceRollWaveLog {
  attackerDice: number[];
  defenderDice: number[];
  attackerLosses: number;
  defenderLosses: number;
  remainingAttackerTroops: number;
  remainingDefenderTroops: number;
}

export interface AttackResolutionLog {
  orderId: string;
  fromTerritoryId: TerritoryId;
  toTerritoryId: TerritoryId;
  defenderId: PlayerId;
  skippedReason?: string;
  waves: DiceRollWaveLog[];
  conquered: boolean;
  troopsMovedOnConquest: number;
  eliminatedPlayerId?: PlayerId;
}

export interface TurnResolutionResult {
  turnNumber: number;
  playerId: PlayerId;
  turnSeed: string;
  reinforcementsEarned: {
    base: number;
    continentBonus: number;
    cardTradeBonus: number;
    territoryMatchBonusTerritories: TerritoryId[];
    total: number;
  };
  draftApplied: DraftPlacementOrder[];
  attackLogs: AttackResolutionLog[];
  fortifyApplied: (FortifyOrder & { executed: boolean; skippedReason?: string }) | null;
  cardDrawn: boolean;
  newState: GameState;
  newStateHash: string;
}
```

### 6.3 `src/types/protocol.ts` (Nostr Event Schemas)

All Nostr game messages use standard signed Nostr events (`kind: 4333` for game state/actions or NIP-33 parameterized replaceable `kind: 30777` for lobby discovery, tagged with `["d", gameId]` and `["t", "nostr-risk-v1"]`).

```ts
export type NostrGamePayload =
  | LobbyCreatePayload
  | LobbyJoinPayload
  | SetupCommitPayload
  | TurnCommitPayload
  | TurnRevealPayload
  | EquivocationProofPayload;

export interface LobbyCreatePayload {
  kind: 'LOBBY_CREATE';
  gameId: string;
  mapSeed: string;
  maxPlayers: number;
  relays: string[];
  hostInitialHashCommitment: string; // C_0 of host
}

export interface LobbyJoinPayload {
  kind: 'LOBBY_JOIN';
  gameId: string;
  playerName: string;
  initialHashCommitment: string;     // C_0 of joining player
}

export interface SetupCommitPayload {
  kind: 'SETUP_PLACEMENT';
  gameId: string;
  action: SetupPlacementAction;
  seedRevealForSetup: string;        // S_1 from each player to seed initial deck & territory deal
}

export interface TurnCommitPayload {
  kind: 'TURN_COMMIT';
  gameId: string;
  turnNumber: number;
  prevStateHash: string;
  prevRevealEventId: string | null;
  actionPlan: TurnActionPlan;
}

export interface TurnRevealPayload {
  kind: 'TURN_REVEAL';
  gameId: string;
  turnNumber: number;
  commitEventId: string;             // Exact Nostr event.id of the TurnCommitPayload
  commitEventJson: string;           // Full serialized TurnCommit Nostr event so any lagging relay gets both!
  revealedSecret: string;            // S_k where SHA256(S_k) === witnessPlayer.currentHashCommitment
  expectedNewStateHash: string;      // H(State_T) after applying turn
}

export interface EquivocationProofPayload {
  kind: 'EQUIVOCATION_PROOF';
  gameId: string;
  turnNumber: number;
  cheaterPubkey: string;
  signedCommitEventJsonA: string;
  signedCommitEventJsonB: string;
}
```

> **Notice `commitEventJson` inside `TurnRevealPayload`**:
> Including the full signed `TurnCommit` Nostr event JSON inside the witness's `TurnRevealPayload` guarantees that **even if a relay missed the active player's `TurnCommit` event**, any client that receives `TurnRevealPayload` automatically receives both the signed commit and the signed reveal in one atomic bundle!

---

## 7. Deterministic PRNG & State Hashing Specification

To guarantee that every browser and OS computes the exact same map, card shuffles, dice rolls, and state hashes (with zero floating-point drift across CPUs):

### 7.1 Deterministic PRNG (`src/crypto/prng.ts`)
- Never use `Math.random()`.
- Use a SHA-256 counter-mode DRBG (Deterministic Random Bit Generator):
  ```ts
  export class DeterministicRng {
    private counter = 0;
    private buffer: Uint8Array = new Uint8Array(0);
    private offset = 32;

    constructor(private readonly seedHex: string) {}

    /** Returns an unbiased integer in [min, max] inclusive using rejection sampling */
    nextInt(min: number, max: number): number { ... }

    /** Rolls a standard 6-sided die (1..6) */
    rollD6(): number {
      return this.nextInt(1, 6);
    }

    /** Fisher-Yates shuffle in-place */
    shuffle<T>(array: T[]): T[] { ... }
  }
  ```
- Each block of 32 bytes is produced by `sha256(utf8ToBytes(`${this.seedHex}:${this.counter++}`))`.
- Use **rejection sampling** on `uint32` values to eliminate modulo bias.

### 7.2 Canonical State Hash (`src/crypto/stateHash.ts`)
- JSON key ordering in JavaScript objects is not guaranteed across arbitrary manipulations unless canonicalized.
- `canonicalStringify(value)` recursively sorts all object keys lexicographically before stringifying, and strips transient UI properties.
- `computeStateHash(state: GameState): string` computes `bytesToHex(sha256(utf8ToBytes(canonicalStringify({ ...state, prevStateHash: '' }))))`.

---

## 8. Simplistic "Dumb Bot" AI Specification (`src/ai/dumbBot.ts`)

For Phase 1 single-player testing, the Dumb Bot must be fast, predictable, and require zero external dependencies while playing legal Classic Risk turns.

### 8.1 Bot Setup Placement (`generateBotSetupPlacement`)
- Identify all owned **border territories** (owned territories that have at least one neighbor owned by an enemy).
- Distribute `remainingSetupTroops` round-robin across owned border territories.

### 8.2 Bot Whole-Turn Action Plan (`generateBotTurnPlan`)
1. **Card Trades**:
   - Check if any 3 cards in `bot.cards` form a valid set (`3 same` or `1 of each`, using `WILD` if present).
   - If `bot.cards.length >= 3`, trade in the highest-value valid set immediately.
2. **Draft Placement**:
   - Compute total draft pool (`base + continentBonus + cardTradeBonus`).
   - Find the bot's border territories that are adjacent to the weakest enemy territories (or belong to a continent the bot owns $\ge 60\%$ of).
   - Place 60% of draft troops on the #1 primary attack staging territory, and distribute the remaining 40% across other border territories.
3. **Attack Queue Generation**:
   - Create a simulated clone of the board state (`simTerritories`) reflecting the bot's draft placements.
   - Loop up to 5 times:
     - Find all owned territories `from` where `simTerritories[from].troops >= 4` and an adjacent enemy territory `to` satisfies:
       $$\text{simTerritories}[\text{from}].\text{troops} \ge \text{simTerritories}[\text{to}].\text{troops} + 2$$
     - Pick the pair `(from, to)` with the highest troop advantage ratio.
     - Push an `AttackCampaignOrder`:
       - `fromTerritoryId: from`
       - `toTerritoryId: to`
       - `stopWhenAttackerAtOrBelow: 2`
       - `occupyMode: { type: 'ALL_BUT_ONE' }`
     - Optimistically update `simTerritories` (assume conquest with expected losses $\approx \text{defenderTroops}$) so the bot can also chain a 1-step follow-up attack if overwhelming!
4. **Fortify Selection**:
   - Find the interior owned territory (no enemy neighbors) with the largest `troops >= 3`.
   - Find a connected border territory via BFS across owned territories and queue a `FortifyOrder` moving `troops - 1` to that border territory.

---

## 9. UI & User Experience Architecture

> **Visual reference:** [`mockups/`](./mockups/index.html) contains clickable prototypes. The chosen direction is **Style A · Neon Grid**: [`style-a-mobile.html`](./mockups/style-a-mobile.html) is the primary target and [`style-a-neon-grid.html`](./mockups/style-a-neon-grid.html) is the desktop layout. Styles B and C are kept for reference only. The mockup map generator is throwaway code; the real generator follows §3.

### 9.1 Art Direction — "Neon Grid" (synthwave / Tron)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#07010f` | App background (deep violet-black) with faint magenta 32–40 px grid lines |
| `--mag` | `#ff2bd6` | Primary accent: attack arrows, active phase, primary buttons (gradient with cyan) |
| `--cyan` | `#19f6ff` | Secondary accent: coastlines, headings, fortify arrows, defender dice |
| `--sun` | `#ffb800` | Numbers that matter: turn number, troops to place, continent bonuses |
| `--lime` | `#39ff14` | Positive outcomes (captured, +troops) |
| `--txt` / `--dim` | `#ece6ff` / `#9b8cc4` | Body text / secondary text |
| Player colors | `#19f6ff #ff2bd6 #39ff14 #ffb800 #a463ff #ff4b4b #f4f4ff #00ffa3` | Index 0 = local human |
| Fonts | **Orbitron** (display, numbers, buttons) · **Share Tech Mono** (body, labels) | Bundle locally (no Google Fonts at runtime) |

**Map rendering style:** territory hexes are filled with the owner color at ~14% opacity and thin inner hex strokes. Each territory gets a ~1.4 px **glowing outline** in its owner color (SVG `feGaussianBlur` glow applied per *layer*, not per element, for performance). Continent borders are drawn as a brighter white line, coastlines as a cyan double stroke, and sea lanes as dotted cyan. Troop badges are dark circles with an owner-colored glowing ring and an Orbitron number. Attack arrows are curved, dashed, and animated (`stroke-dashoffset`) in magenta with numbered order dots; fortify arrows use cyan. The menu uses a striped synthwave sun, a cyan horizon line, and an animated perspective grid floor behind frosted-glass panels.

### 9.2 Mobile-First Principles (phones are the primary platform)

1. **The map is the screen.** On phones the board fills everything between a slim top bar and the bottom sheet. Desktop adds sidebars, but they show the same information.
2. **One phase at a time.** The planner is a bottom sheet that only shows the current step (`DRAFT → ATTACK → FORTIFY → COMMIT`). Phase tabs sit above the sheet with count badges, such as troops left to place or attacks queued.
3. **Primary action in the thumb zone.** The large gradient "NEXT ▸ / COMMIT TURN" button is always at the bottom-right of the sheet.
4. **Progressive disclosure.** Territory names are hidden at full-map zoom and fade in when zoomed past ~1.4×. Tapping a territory shows a transient info pill (name · owner · continent +bonus · troops) that auto-hides after 2.5 s. Commanders, continent progress, settings, and a collapsible **Battle Log** (closed by default, just above 📜 EVENT LOG) live in a ☰ slide-out drawer.
5. **Contextual highlighting instead of instructions.** After selecting a source, valid targets pulse and everything else dims (`highlight` set → `.target` / `.dim` classes). A short hint line and toasts explain invalid taps.
6. **Portrait auto-rotation (view-only).** When the board is taller than it is wide, the renderer rotates coordinates 90° so the landscape-shaped map fills a portrait phone. Map data, IDs, and adjacency are untouched, so every device stays in sync for multiplayer. Text stays upright because only positions rotate.
7. **Touch gestures.** Use one-finger drag to pan, two-finger pinch to zoom, and the mouse wheel on desktop. ⤢ resets to fit. A tap counts only if the pointer moved less than 6 px, so panning never fires a tap. Use `touch-action: none` on the board, a minimum hit target of 44 px for buttons, and `env(safe-area-inset-*)` padding.
8. **Responsive breakpoint.** Use the phone layout below 700 px width. At ≥ 700 px, use the desktop three-column layout (roster/continents | map | planner) with the collapsible battle log at the bottom of the left column.

### 9.3 Screen Flow

1. **Main Menu** (mobile layout shown; desktop shows the same controls in a 3-column glass panel):
   - Title block (`NEON / DOMINION`, synthwave sun, grid floor).
   - Mode segmented control: **SOLO** (Phase 1) | **NOSTR 🔒** (Phase 2, disabled).
   - **Commanders stepper `− N +`** (2–8) with a row of colored dots (`YOU`, `BOT`, …).
   - **Live map preview card** with a **⟳ NEW MAP** button and a one-line stats summary (territories · continents · hexes).
   - **Advanced ▸** (collapsed) contains the **map seed** text field. It is for sharing or replaying a specific map, and most players never open it.
   - **START ▸** full-width button.
   - **Map seed behavior:** every new game gets a **fresh random seed** (on menu load, on every commander-count change, and on ⟳). The same `(seed, playerCount, generatorVersion)` always reproduces the same map. In Phase 2 the seed comes from the lobby protocol instead of the menu (see §5.4).
2. **Game Board**:
   - **Top bar:** ☰ drawer button · `TURN 07` · player dots (territory count inside; active player filled and glowing) · ⤢ fit button. Desktop also shows the phase chips and the `STATE`/`CHAIN` hash pills (click to open the Nostr text inspector).
   - **Board:** the interactive SVG hex-cluster map (see 9.1). During planning, show projected troops and arrows for queued orders. Map rotation follows the full game viewport's aspect ratio, not the board's remaining height, so deploying troops or expanding panels does not rotate the map. Mobile controls reserve a stable sheet and phase-bar area; content scrolls inside the sheet instead of resizing the map when selections change. Only bot replays control the camera: start with a whole-map overview, follow actions, then finish returning to the whole map before handing back to the player. Player actions and replays never auto-zoom or reset the camera. Pan, pinch/wheel zoom and explicit Fit remain available. Numeric controls use 16px text to avoid phone focus zoom, and buttons disable double-tap zoom without disabling manual pinch zoom.
   - **Bottom sheet by phase:**
     - **Draft:** large `N TROOPS TO PLACE` counter with a breakdown (base + continents + cards), a card-set trade button when a valid set exists (mandatory at 5+ cards), placement chips (`ARCOLOGY 9 +9`), **UNDO**, and **ATTACK ▸**. Tap an owned territory for +1. Long-press for +5 is a nice-to-have.
       - **Cards help:** a keyboard-accessible **?** beside **CARDS** expands inline help, even with an empty hand. Explains earning cards, set values (from the rules constants), wilds, automatic highest-value selection, mandatory trades, the territory-match bonus, and undoing planned trades.
     - **Attack:** hint line; tap an owned territory with ≥ 2 troops (or a territory captured by an earlier queued order, which makes a **chained** order), then a pulsing enemy neighbor. Queued orders are compact rows: `#n FROM → TO [STOP≤2] [ALL−1] ×`. Tapping a chip cycles its value. Removing an order also removes any chained orders that depend on it.
       - **Interactive Stop At:** counts remaining attacking armies, excluding the one reserved on the source. A setting of 13 means a source threshold of 14 total troops. Waves continue until conquest or the source reaches or falls below that threshold; a two-loss wave can cross it. Editing the count or pressing **STOP AT** enables the limit; pressing **STOP AT** again keeps it enabled. The highlighted button indicates an active limit, and **OFF** explicitly disables it. An active setting is clamped for smaller attacking forces rather than silently turned off. With only one attacking army the control is disabled and the limit is not applied.
       - **Battle Results:** after each interactive attack, the move and attack sheets show a collapsible **BATTLE RESULTS** section (collapsed by default, open state kept for the rest of the session) listing every roll of the last attack: attacker vs defender dice, the round winner (attackers / defenders / split) and each side's losses. Rendered by `ui/components/battleResults.ts`.
       - **Victory:** capturing the entire map (not just a majority) ends the game automatically after confirming troop movement into the last territory. No Fortify or End Turn is required. The **YOU WIN** window shows the final round and per-commander captures, kills, losses and peak territory counts, followed by **OUT** (the round eliminated, or a dash for survivors). No further bot turns run, and **STATS** reopens the summary.
     - **Fortify:** tap a source, then any pulsing **connected** owned territory. A row shows `FROM ⇢ TO [− n +]`, with **CLEAR** to remove it. This step is optional.
     - **Commit:** summary tiles (placed · attacks · fortify). **COMMIT TURN** is disabled while troops are unplaced. Explain in one line that the plan is signed and the dice stay sealed until the next commander reveals.
   - **Commit overlay:** spinner while sealing (`commit <hash>`), "Waiting for BOT-ALPHA to reveal…", then hand off to the Battle Replay.
3. **Battle Replay Animator (`battleReplayPlayer.ts`)**:
   - Full-screen overlay on mobile. Play back `TurnResolutionResult` with **Skip** and speed controls (`1×`, `2×`, `Instant`):
     - Flash draft troop additions.
     - Step through each `AttackResolutionLog` wave by wave: auto-pan/zoom the camera to the active border, show rolling 3v2 dice (magenta attacker, cyan defender), decrement troop counts, flip the territory color on conquest, and announce card draws.
   - Bot turns run their commit-reveal automatically and play back the same way. Add a setting to auto-skip bot replays and show only the summary toast.

### 9.4 UI Code Structure

```text
src/ui/
├── theme.ts                # Neon Grid tokens (§9.1) as TS constants + CSS custom properties
├── layout.ts               # Breakpoint detection (phone < 700px), portrait detection for map rotation
├── screens/
│   ├── mainMenu.ts
│   ├── gameScreen.ts       # Hosts board + phase sheet (mobile) or sidebars (desktop)
│   └── victoryModal.ts
└── components/
    ├── hexMapRenderer.ts   # render(map, state, { rotate, highlight, plan }) → SVG; returns view box
    ├── mapCamera.ts        # Pan / pinch / wheel / fit; tap-vs-drag discrimination
    ├── phaseSheet.ts       # Draft / Attack / Fortify / Commit sheet contents
    ├── intelDrawer.ts      # Roster, continents, last-turn log
    ├── territoryPill.ts    # Transient tap info
    └── battleReplayPlayer.ts
```

The renderer must scope SVG `<defs>` IDs per SVG instance. Otherwise a hidden SVG with the same `id="glow"` hijacks `url(#glow)` references, which was a real bug found in the mockups.

---

## 10. Transport Abstraction Layer (`src/transport/`)

To ensure Phase 1 (Single Player) and Phase 2 (Nostr Multiplayer) share 100% of the engine and UI code, define `GameTransport`:

```ts
export interface GameTransport {
  readonly mode: 'LOCAL' | 'NOSTR';
  getInitialState(): GameState;
  submitSetupPlacement(action: SetupPlacementAction): Promise<GameState>;
  submitTurnCommit(plan: TurnActionPlan): Promise<{
    commit: TurnCommitPayload;
    reveal: TurnRevealPayload;
    resolution: TurnResolutionResult;
  }>;
  onTurnResolved(callback: (result: TurnResolutionResult) => void): () => void;
  exportFullGameLogJson(): string;
}
```

- **`LocalSinglePlayerTransport` (Phase 1)**:
  - Generates real 500-step SHA-256 hash chains for the human player and every bot at game start!
  - Even in single-player mode, every turn goes through the exact `TurnCommitPayload` -> `TurnRevealPayload` -> `verifyHashChain` -> `applyTurn` pipeline.
  - Provides a **"View Nostr Event Log"** drawer in the UI so the user can inspect the exact text events and state hashes being generated on every turn.
- **As implemented (step 1.13):** see [`src/transport/transport.ts`](./src/transport/transport.ts), [`localTransport.ts`](./src/transport/localTransport.ts), and [`src/types/protocol.ts`](./src/types/protocol.ts).
  - **Events** use the envelope `{ id = SHA256(canonical {author, seq, payload}), author, seq, payload }`, with payloads `GAME_CREATE`, `SETUP_PLACEMENT`, `TURN_COMMIT` (carries the hash of the state the plan was made against), and `TURN_REVEAL` (carries `witnessIndex` and `expectedNewStateHash`).
  - **Chains:** local chains are 2000 secrets long.
  - **Local interactive turns:** commit the starting plan, consume one witness secret, and append the reveal only at completion. The reveal includes ordered `interactiveSteps` (attack orders, conquest troop moves and fortifications), and the final state hash. Replay re-executes these steps with the same per-attack seeds, verifies the final hash and supplies full attack logs for battle history and statistics. Turns notify listeners once, at completion. Older synthetic interactive reveals without these decisions cannot reconstruct their missing attack history.
  - **`replayEventLog(text)`** rebuilds and verifies a whole game from the log alone. **`save()`/`restore()`** keep the private chain roots separate from the public log.
  - **`lastRevealEventId`** stays `null` in state, because a reveal can't contain its own id. In Phase 2 the *next* commit references the previous reveal's id instead.
- **`NostrMultiplayerTransport` (Phase 2)**:
  - Uses `SimplePool` from `nostr-tools` connected to the match's relay list.
  - Subscribes to `{ kinds: [4333], "#d": [gameId] }`.
  - Implements the `1500ms` multi-relay quorum check, automatic `EquivocationProof` detection, and embedded `commitEventJson` inside `TurnRevealPayload`.

---

## 11. Step-by-Step Implementation Plan

> **Progress is tracked in [CHECKLIST.md](./CHECKLIST.md).** It breaks the phases below into numbered, single-session steps, each with "done when" criteria and handoff notes. If this section and the checklist disagree on status, the checklist wins. This section describes *what* each phase contains.

When implementing this codebase, follow this exact sequence and verify each stage before moving to the next:

### Phase 1A: Project Scaffolding & Cryptographic Core — 🟡 partial (scaffold + `prng.ts` + tests done; `hashChain.ts`, `stateHash.ts` remaining)
1. Initialize `package.json` (`vite`, `typescript`, `vitest`, `@noble/hashes`, `nostr-tools`), `tsconfig.json`, and `index.html`.
2. Implement `src/crypto/prng.ts` (SHA-256 counter DRBG), `src/crypto/hashChain.ts` (500-step SHA-256 chain generator & verifier), and `src/crypto/stateHash.ts` (canonical JSON SHA-256).
3. Write unit tests verifying deterministic PRNG output and hash chain preimage verification.

### Phase 1B: Procedural Hex-Cluster Map Generator — ✅ done
1. `src/engine/hexMath.ts`: axial coordinates, neighbors, distance, hex lines, and pixel/corner helpers for rendering.
2. `src/engine/mapGenerator.ts`: the mixed-landmass generator from §3 (paired mainland frontiers, smaller islands, bridges and sea lanes, validation with deterministic retries).
3. Tests: 15 seeds × 7 player counts check counts, contiguity, sizes, degree ≥ 2, chokepoint-only cross-continent borders, ≤ 3 links per continent, connectivity, and determinism.
4. **Map Lab** (`index.html` + `src/main.ts`): a mobile-first Neon Grid page with ⟳ GENERATE NEW MAP, a commander stepper, continents always shown with distinct per-territory shades and etched inner borders, no special chokepoint styling because bridges read as land and sea lanes as dotted links (ownership is dealt at game start, not at map generation), a tap-for-territory info pill, pan/pinch/zoom, portrait auto-rotate, and a shareable `#p=&seed=` link. It becomes the main menu's preview component in Phase 1E.

### Phase 1C: Classic Risk Deterministic Engine
1. Implement `src/engine/rules.ts`:
   - Setup territory deal (`auto_deal_manual_troops`).
   - Reinforcement calculation ($\max(3, \lfloor T/3 \rfloor)$ + full continent control + Fixed Set Card bonuses: Infantry=4, Cavalry=6, Artillery=8, One-of-each=10, +2 territory match bonus, mandatory trade at $\ge 5$ cards).
   - Connected-path fortification check via BFS on owned territories.
2. Implement `src/engine/combatResolver.ts` & `src/engine/turnEngine.ts`:
   - Pure function `applyTurn(state, actionPlan, revealedSecret)` that validates the hash-chain reveal, derives `turnSeed = SHA256(commitId + ":" + revealedSecret)`, executes card trades, draft placements, chained `AttackCampaignOrder` waves (3v2 dice, defender wins ties), card draws, player eliminations, and fortify moves, returning `TurnResolutionResult`.
3. Write unit tests covering combat rules, chained attacks, card trades, connected fortify, and identical state hashes on replay.

### Phase 1D: Dumb Bot AI & Local Commit-Reveal Transport
1. Implement `src/ai/dumbBot.ts` for both `SETUP_PLACEMENT` and `TURN_ACTION_PLAN`.
2. Implement `src/transport/localTransport.ts` wiring the human player and `1..7` Dumb Bots through the real cryptographic commit-reveal pipeline.

### Phase 1E: Interactive Web UI (Mobile-First), Map Renderer, & Battle Replay
1. Implement the Neon Grid theme tokens (§9.1) and bundle Orbitron + Share Tech Mono locally.
2. Build the **mobile** Main Menu first (commanders stepper, live preview, ⟳ new map, Advanced seed field, random seed per game), then the desktop variant at ≥ 700 px.
3. Build the SVG Hex-Cluster Map renderer (layer-level glow, continent/coast/sea-lane strokes, troop badges, animated attack arrows, `highlight` and `rotate` options) plus `mapCamera.ts` (pan, pinch, wheel, fit, tap-vs-drag).
4. Build the **phase bottom sheet** (Draft → Attack with chained orders → Fortify → Commit), the ☰ intel drawer, and the territory info pill. Then build the desktop sidebars from the same components.
5. Build the **Battle Replay Player** (camera follows each battle, animated dice waves, capture transitions, Skip/speed controls) and the **Nostr Text State Inspector** showing the serialized JSON events and hash-chain reveals.
6. Verify `npm run build` and `npm test`, then play a complete single-player game from Main Menu to Victory at **390×844 portrait** and at **1600×900 desktop**.

### Phase 2 (Future Expansion): Live Nostr Relay Multiplayer
1. Implement `src/transport/nostrTransport.ts` using `nostr-tools` `SimplePool`.
2. Add NIP-07 browser extension login (`window.nostr`) + ephemeral local keypair fallback.
3. Add the Multiplayer Lobby UI (create/join game across configurable Nostr relays, display live hash-chain commitments and equivocation monitor).
