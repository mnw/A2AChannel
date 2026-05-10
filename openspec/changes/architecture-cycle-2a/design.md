## Context

A2AChannel landed `architecture-cycle-1` (the prior `architecture` branch, merged to main as commits `2a383e0` through `b7a58d6`) which sealed the agent-registry four-structure invariant, consolidated the slash-command cluster, locked the Tab cold-start invariant, and paired Channel-tool schema with handler. Phase 3 (Room summary) merged to main as commits `bdcaf80` through `810c1a7` covering ADRs 0001/0002/0003.

This cycle (architecture-cycle-2a) targets the next layer of friction on the **Hub side**: the three near-duplicate Kind files and the inline-route monolith inside `hub.ts`. Two parallel architecture-skill explorations produced complementary plans — one Hub-deep ("Plan A": LedgerEntity + RouteModule + Fanout + BriefingDispatcher), one three-prong wide ("Plan B": KindBase + KindStore + KindRenderer + Tab split + CaptureTransaction + kinds.css). A side-by-side SWOT showed each plan independently identified real friction the other missed; merging is strictly better than either alone.

The work was originally scoped as one combined `architecture-cycle-2`. After review feedback flagging that 1.5–2 weeks of test-agent install.sh churn would compound disruption to the long-running Drupal/Copernicus/Django/EIFE sessions, the cycle was split at the Hub|Webview boundary (which has no shared files). **`architecture-cycle-2a` (this change) covers Hub-only work.** **`architecture-cycle-2b`** (separate OpenSpec change) covers Webview + Rust and lands on top of a stable, soaked 2a. The two cycles share only the orchestration-shape decision from pre-grill 1.1 (which the Webview's KindRenderer mirrors); otherwise they touch disjoint files.

The 2a cycle is sequential, single-branch, per the saved feedback memory ("recurring deepening passes on a fresh `architecture` branch: per-candidate commits, manual smoke-test, ff-merge to main, delete branch"). All 2a candidates touch hub.ts and the kinds files heavily; parallel branches would produce merge conflicts that consume more time than the cycle saves.

Stakeholders: A2AChannel (single-developer codebase), the long-running test agents (Drupal/Copernicus/Django/EIFE) whose live sessions are the smoke-test surface.

## Goals / Non-Goals

**Goals:**

- Carve `LedgerEntity<Snapshot>` (external) + private `Store<Snapshot>` closure (per pre-grill 1.1 outcome) such that each `hub/kinds/<kind>.ts` shrinks to a `StateMachineDecl` + `VerbDecl[]` (each verb carrying a pure `decide(prior, payload, cap): Decision` callback); the load → decide → transact → emit lifecycle lives once inside `LedgerEntity`.
- Generalize `KindModule.routes` into a `HubFeature` (or grilled-name) contract that the dispatcher consumes; carve hub.ts's inline routes (chat, transcript, room settings, attachments, sessions, usage, roster, stream, agent-stream) into dispatcher-resident modules. Target: hub.ts at ≤300 LOC of pure wiring (irreducible floor is ~225-275 LOC of imports + env-resolution + ledger open + module construction + capability factory + Bun.serve startup + sweep/shutdown handlers + human registration; the 300 budget allows comfort vs an aggressive squeeze that would force inlining).
- Centralize all SSE broadcast paths into a single `Fanout` module with `Scope` as the contract; eliminate ad-hoc loops over `uiSubscribers + agents.values()`. Move `<private>` redaction-on-persist into `Fanout`.
- Lift the Briefing re-issue debounce + dedup into `BriefingDispatcher`; remove its module-scope state from hub.ts.
- Delete `cap.ids.mint` (shallow surface kinds bypass) and `cap.sse.emitWhere` (sole caller migrates to the new `room-ambient` scope).
- Land each candidate as a discrete commit, smoke-tested before the next starts. No bundled commits.
- Strip any debug instrumentation added during the cycle before merge (per the saved feedback memory).

**Non-Goals:**

- **No external API changes.** MCP tool names, HTTP route shapes, SSE event kinds, ledger schema all preserved. The migration is internal.
- **One additive ledger migration only** (v11 → v12 — adds `version INTEGER NOT NULL DEFAULT 0` to `handoffs`, `interrupts`, `permissions`; backfills from `MAX(seq) FROM events`). This is required by the post-grill orchestration-shape decision to materialize `version = events.seq` on the derived row (the structural fix for today's `listByStatus` N+1). No other schema changes.
- **No changes to the Channel sidecar (`hub/channel/*`).** The chatbridge transport stays as-is.
- **No Webview changes.** `KindRenderer` + `KindCard` + per-Kind CSS consolidation + `Tab`/`XtermBinder`/`PtyEvents` split are scoped to `architecture-cycle-2b`. 2a does not touch `ui/`.
- **No Rust changes.** `CaptureTransaction` (RAII over closure-defer) is scoped to `architecture-cycle-2b`. 2a does not touch `src-tauri/`.
- **No changes to the Hub/Channel/Shell process split** (CLAUDE.md hard rule).
- **No llama-cpp adapter implementation.** That's a separate deliverable; the stubbed adapter in `hub/core/summariser/index.ts` stays stubbed.

## Decisions

### Decision 1: Hybrid `LedgerEntity<Snapshot>` with private `Store` closure (RESOLVED 2026-05-10 via pre-grill 1.1)

**Choice:** A single external Module — `LedgerEntity<Snapshot>` — is the only thing Kind code learns. It exposes:
- `apply(id, verb, payload, cap, scope)` — common case, ~5 LOC at each call site
- `applyWithSideEffect(id, verb, payload, cap, scope, sideEffect)` — rare case for cross-table writes (today: handoff accept's nutshell patch; the `SideEffectCtx.tx` is transaction-scoped, cannot open a new tx, cannot reach the Store)
- `listByStatus(filter)` — single-query SELECT against the `version` column materialized on the derived row
- `load(id)` — primary-key lookup
- `sweep(selector, verb, cap)` — TTL bulk transitions (one event per row, all in one tx)

An internal `Store<Snapshot>` Module exists inside `LedgerEntity`'s closure (created via `createSqliteStore` for production / `createInMemoryStore` for tests) but is NOT exposed via any property or getter. Tests that need the Store hold their own reference before passing it to `createLedgerEntity({ decl, store })`.

Idempotency policy lives in each verb's `decide(prior, payload, cap)` callback, returning the appropriate arm of `Decision = { kind: "idempotent" | "conflict" | "transition" }`. Permission's first-verdict-wins reduces to "any terminal status returns the prior entry as idempotent" — no `IdempotencyPolicy` enum required.

**Alternatives considered (full grilling outcomes recorded in ADR-0004):**

- **Fused `LedgerEntity` (no internal Store seam)** — single module, all SQL inside. Rejected because the nutshell coupling has no clean shape: the only proposal was an undocumented `cap.db.run` escape "limited to one extra UPDATE" — a discipline a single-developer codebase will not maintain.
- **Split `KindBase` + `KindStore<Snapshot>` (two external Modules)** — pure ports-and-adapters shape. Rejected because (i) it forces every verb's declaration to carry an `aux` field whether used or not, polluting the common case; (ii) it requires an `IdempotencyPolicy` discriminated enum on every VerbDecl when the same logic folds cleanly inside `decide` for the hybrid shape; (iii) "two adapters means a real seam" — today we'd have one production SQLite store + one in-memory test store = hypothetical seam. Paying for the publicity (an exported `KindStore` interface to learn) without a second production adapter is not earned.

**Why the hybrid wins:**

- Common case is genuinely 5–6 lines at the verb call site; rare case has a NAMED separate method, so cross-table coupling cost is paid only when used.
- Idempotency policies (handoff same-status-retry, permission first-verdict-wins) reduce uniformly inside each verb's `decide` callback. No per-policy enum.
- LANGUAGE.md test passes honestly: the `Store` seam is acknowledged as currently hypothetical (one production + one test fake) per the "two adapters means a real seam" rule. The cost (~80 LOC of `Store` interface + factory) is justified by the test-velocity benefit (sub-millisecond verb tests + idempotency edge case coverage). The seam becomes "earned" the day a second production adapter (e.g. multi-process / Postgres) appears.
- Per-Kind LOC after migration: handoff 603→~165, interrupt 365→~110, permission 481→~140. All three under the 200 LOC target.

### Decision 2: `HubFeature` (working name) extends `KindModule` rather than replacing it

**Choice:** Generalize `KindModule.routes: RouteDef[]` into a parent `HubFeature` interface with just the routes, and have `KindModule extends HubFeature` add the kind-specific bits (`pendingFor`, `toolNames`, `migrate`, `kind` prefix). The dispatcher consumes `HubFeature[]`; the briefing aggregator continues to filter for the `KindModule` subtype.

**Alternatives considered:**
- Replace `KindModule` outright with a flat `Module` interface — rejected because non-kind routes don't have `migrate` / `pendingFor` / `toolNames` and adding optional fields makes the interface larger, not smaller.
- Two parallel interfaces with no inheritance — rejected because the dispatcher would then need two registration arrays and two iteration paths to compute auth/body-cap dispatch.
- A flat list with a discriminated union on a `kind: "feature" | "kind-module"` tag — rejected as needlessly verbose; TypeScript's structural subtyping handles this naturally.

**Rationale:** Inheritance models the actual relationship cleanly: every Kind is a feature (provides routes) but not every feature is a Kind. The dispatcher's contract is "give me an array of things with `routes`" and that's exactly what `HubFeature` provides.

### Decision 3: SSE handlers live outside the dispatcher

**Choice:** `handleStream` (Webview SSE) and `handleAgentStream` (per-Agent SSE) stay as direct routes in hub.ts (or a thin `hub/features/streams.ts` register-with-Bun.serve module), not inside the dispatcher.

**Alternatives considered:** Add an `sse: true` flag to `RouteDef` and let the dispatcher special-case long-lived connections. Rejected because the dispatcher's contract assumes request-response semantics (auth check → body parse → handler returns Response); SSE handlers return a stream that runs for the connection's lifetime, plus they own per-connection state (briefing, hydration trigger, kind replay). Forcing them through the dispatcher dilutes the dispatcher's contract for marginal symmetry gain.

**Rationale:** Two different lifecycle shapes deserve two different surfaces. Both can still be RouteModule-organized (registered alongside Chat, Transcript, etc. in `hub/features/`) — they just don't go through `dispatcher.dispatch()`.

### Decision 4: `Fanout.send(entry, scope, opts?)` — explicit `Scope` widening

**Choice:** Extend the existing `Scope` enum with two new variants: `{ kind: "ui-only-ambient" }` (no chatLog persist) and `{ kind: "room-ambient", room }` (no chatLog, no transcript write). Existing four (`broadcast`, `to-agents`, `ui-only`, `room`) preserved.

**Alternatives considered:** Add `recordInChatLog: boolean` and `recordInTranscript: boolean` flags on `opts` rather than widen the enum. Rejected because the flags would need to combine sensibly with the four scope kinds — the matrix is small enough today that exhaustive named scopes are clearer than orthogonal flags.

**Rationale:** Each scope name encodes a complete delivery policy. Callers choose by intent ("this is an ambient UI ping") rather than by composing flags ("not chatLog and not transcript and only UI subscribers"). The interface is the test surface — named scopes give cleaner test cases.

### Decision 5: Sequential commits in dependency order; smoke-test gate between each

**Choice:** Land candidates as discrete commits in the order: KindStore → KindBase → HubFeature → Fanout → BriefingDispatcher → cap.ids.mint cleanup. Each commit must compile + pass `bun x tsc --noEmit` + drive the running app through the relevant verbs before the next commits.

**Alternatives considered:** Batch the Hub-side candidates into one combined commit. Rejected because batched commits prevent per-candidate revert; if KindBase introduces a bug, we'd have to revert KindStore + HubFeature + Fanout to undo it. Discrete commits give clean rollback.

**Rationale:** The saved feedback memory ("Architecture-skill cadence: per-candidate commits, manual smoke-test") encodes the right cadence. Each commit has its own well-defined scope and revert path.

## Risks / Trade-offs

- **`LedgerEntity` over-abstraction.** The three Kinds' state machines genuinely differ (handoff: 5 statuses + sweep + by/from actor; interrupt: 2 statuses + ack only; permission: 4 statuses + first-verdict-wins idempotency stronger than same-status retry). → **Mitigation (resolved):** Pre-grill 1.1 ran INTERFACE-DESIGN.md's parallel sub-agent design on three competing shapes; the hybrid shape was selected because the `decide(prior, payload, cap): Decision` callback collapses all three idempotency policies uniformly (first-verdict-wins is "any terminal status → idempotent"; same-status-retry is "target === current.status → idempotent"). See ADR-0004.

- **`HubFeature` naming bikeshed risk.** `Module` collides with LANGUAGE.md vocabulary; `HubFeature` and `Surface` are candidates. → **Mitigation:** Settle the name in the grilling phase (pre-grill 1.2) BEFORE writing the contract. Add the chosen term to `CONTEXT.md`'s Glossary. A grep-rename later is cheap but distracting.

- **Long-running test agents are the smoke-test surface.** Drupal/Copernicus/Django/EIFE are mid-task; install.sh restarts disrupt their work. → **Mitigation:** Per CLAUDE.md's "tmux sessions survive A2AChannel restart" rule, the agents reconnect cleanly. But each install.sh is still a 30-60s gap. Group the smoke-test cadence by minimizing redundant restarts (test as many candidates as possible per restart).

- **`hub.ts` shrinking from 901 → 200 LOC means a lot of code moves.** Risk of subtle behavioural drift if a route handler's auth check or body-cap is subtly different in its new home. → **Mitigation:** The dispatcher already enforces `auth: "mutating" | "read"` and `bodyMax` per `RouteDef`; route migrations express these declaratively rather than in inline code, which actually shrinks the failure surface. Verify per-route via the smoke-test cadence.

- **CLAUDE.md is gitignored** — not committed. Updates to its hard rules during this cycle (e.g. "kinds bypass cap.events.insert" rule deletion when KindStore lands) live only in the user's local copy. → **Mitigation:** Keep the public ADRs (`docs/adr/`) as the source of truth for architecture decisions. CLAUDE.md is the runtime contract; ADRs are the audit trail.

## Migration Plan

### Dependency DAG (not strictly linear)

```
                ┌──────────────────┐
                │ 1. Pre-grilling  │  (locks Decision 1 shape + naming)
                └────────┬─────────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
        ┌──────────┐  ┌────────┐  ┌──────────┐
        │ 2. Store │  │ 5. Hub │  │ 4. cap.  │
        │  (or in  │  │ Feature│  │ ids.mint │
        │  fused)  │  │ + carve│  │  cleanup │
        └─────┬────┘  └───┬────┘  └──────────┘
              ▼           │       (independent)
        ┌──────────┐      │
        │ 3. Base  │      │
        │  (or in  │      │
        │  fused)  │      │
        └─────┬────┘      │
              │           ▼
              │     ┌──────────┐
              └────►│ 6. Fanout│
                    └────┬─────┘
                         ▼
                   ┌──────────┐
                   │ 7. Brief │
                   │  Disp.   │
                   └──────────┘
```

**Hard dependencies:**
- 6 (Fanout) depends on 5 (HubFeature) — Fanout is consumed via the new feature-resident routes. Benefits from but does not strictly require 2–3.
- 7 (BriefingDispatcher) depends on 6 — it uses `Fanout.send` for the dedup'd re-brief delivery.
- 3 (KindBase) depends on 2 (KindStore) since orchestration calls store. (Fused alternative collapses 2+3 into one section.)
- 4 (cap.ids.mint cleanup) is independent.
- 5 (HubFeature) is independent of 2–4. If pre-grilling stalls, 5 can ship first.

**Intermediate states the plan accepts:**
- After 3 lands but before 6: `KindBase` calls today's `cap.sse.emit` which delegates to today's inline `emit()`. Functionally fine; tests written in 3.11 must accept either pre- or post-Fanout broadcast semantics.
- After 5 lands but before 6: `cap.sse.emit` still uses inline broadcast; feature-resident routes call it directly. Fine; the broadcast rewrite is internal.

### Steps

1. **Branch:** `architecture-cycle-2a` off main. Per the saved feedback memory, branch is short-lived: created → commits land → ff-merge → delete.
2. **Pre-grill:** Run `/improve-codebase-architecture`'s INTERFACE-DESIGN.md flow on the orchestration shape (fused `LedgerEntity` vs split `KindBase`+`KindStore` vs hybrid). Settle `HubFeature` naming. Settle Tab-split gate as a literal smoke-checklist file.
3. **Hub-side commits in order:**
   1. `feat(ledger): LedgerEntity<Snapshot> + private Store closure; per-Kind derived-row migration into the entity`
   2. `refactor(kinds): handoff/interrupt/permission as StateMachineDecl + VerbDecl over LedgerEntity`
   3. `refactor(kinds): delete cap.ids.mint shallow surface; kinds use typed mint helpers`
   4. `feat(hub): HubFeature interface + dispatcher acceptance; carve hub.ts inline routes into hub/features/`
   5. `feat(hub): Fanout module owning all SSE broadcast paths`
   6. `feat(hub): BriefingDispatcher owning re-brief debounce + dedup`
4. **Each commit:** `bun x tsc --noEmit` clean + `bun build hub/hub.ts --target=bun` succeeds + `./scripts/install.sh` + manual smoke-test of the affected flow. No commit lands without these four green.
5. **Post-cycle:** Strip any debug instrumentation introduced during smoke-testing (per the saved feedback memory). Final pass on each commit's diff before merge.
6. **Ship 3 ADRs alongside the cycle:** ADR-0004 (orchestration shape — hybrid `LedgerEntity` + private `Store` closure; records the pre-grilling outcome and the rejected alternatives), ADR-0005 (HubFeature parent contract via structural subtyping + the chosen name), ADR-0006 (SSE handlers live outside the dispatcher). These are definite deliverables, not conditional on "any decision warranting one." (ADR-0007 covering Rust `CaptureTransaction` ships with `architecture-cycle-2b`.) ADR-0004 and ADR-0005 are drafted at pre-grill close (2026-05-10); the files land alongside the relevant commits.
7. **Merge:** Fast-forward `main` to `architecture-cycle-2a`. Delete the branch. Delete the CLAUDE.md hard rules that have become structural facts: "Never mutate `knownAgents`/`agentQueues`/`agentConnections` individually" (already structural via AgentRegistry from cycle-1; can be deleted now), "exactly one event + one derived-table update in one transaction" (becomes structural via `LedgerEntity.apply` owning the transaction), "Never enumerate agent queues from inside a kind" (becomes structural via `Fanout`). Edit (don't delete) the `slash-discovery.js` reference in the slash-commands rule and any other references that drift during this cycle.
8. **Soak:** Run on main for **at least one week** with the long-running test agents active. Surface any latent regressions before `architecture-cycle-2b` lands on top. Saved feedback memory ("branches stay isolated until stable") applies — main stability is the gate to starting 2b.
9. **Rollback:** Each commit is independently revertable. Worst-case: revert from the most recent commit backward; prior commits stay landed.

## Open Questions

- **~~`HubFeature` vs `Surface` vs another name.~~ RESOLVED 2026-05-10:** `HubFeature` selected via 1.2 grill. See ADR-0005.
- **Should `Fanout` own the `lastBriefingSig` dedup state, or does that stay with `BriefingDispatcher`?** Argument for both ways; default to BriefingDispatcher (concern is briefing-specific, not broadcast-general) unless a second signature-dedup case appears.
- **~~`pendingFor` default impl location.~~ RESOLVED:** Default lives on `KindModule` itself, calling `entity.listByStatus({ status: "pending", for: agent.name })`. Per-Kind override only when cross-status replay is needed (none today).
