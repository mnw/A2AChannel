# SSE long-lived handlers (/stream, /agent-stream) live outside the HubFeature dispatcher

`architecture-cycle-2a` carves all of A2AChannel's HTTP routes into HubFeature modules under `hub/features/` consumed by a single dispatcher (`hub/core/dispatcher.ts`). The dispatcher applies per-route auth + body-size caps + ledger guards before invoking the handler. Two routes — `/stream` (Webview SSE) and `/agent-stream` (per-Agent SSE) — are NOT registered as HubFeature route entries and do NOT go through `dispatcher.dispatch`. Instead they live in `hub/features/streams.ts` as a separate `StreamHandlers` shape and are wired directly into the `Bun.serve` `fetch(req)` URL match in `hub.ts`.

## Considered Options

- **Add an `sse: true` flag to `RouteDef` and special-case long-lived connections inside the dispatcher.** Rejected: the dispatcher's contract is request-response (auth check → body parse → handler returns Response). SSE handlers return a stream that runs for the connection's lifetime, plus they own per-connection state (briefing send + signature seed, room hydration trigger, room-summariser backfill trigger, kind replay, queue subscribe-and-pull loop). Forcing them through the dispatcher would dilute the dispatcher's contract for marginal symmetry gain.
- **Keep them as standalone functions in `hub.ts` (status quo before §4).** Rejected: hub.ts was already 901 LOC; carving everything else out and leaving these inline would leave them as the single biggest non-wiring chunk. Carving them into `hub/features/streams.ts` keeps `hub.ts` close to wiring-only while preserving their direct-Bun.serve registration.
- **Two parallel dispatcher subsystems (one for request-response, one for long-lived).** Rejected: over-abstracted for two routes. The Bun.serve `fetch(req)` already has the `if (pathname === "/stream")` check; that's the dispatcher for SSE and there's nothing to abstract.

## Consequences

- **`StreamHandlers` is a separate shape** from `HubFeature`: `{ handleStream(req): Response; handleAgentStream(agent, room): Response }`. `hub/features/streams.ts` exports `createStreamHandlers(deps): StreamHandlers`; hub.ts wires the returned handlers into the `Bun.serve.fetch` url match before delegating everything else to `dispatch(req, url)`.
- **Auth is applied inline in hub.ts** for SSE routes (`requireReadAuth(req, url)`), matching the dispatcher's behavior for `auth: "read"` routes. Read-auth accepts `?token=<...>` query params (mandatory for `EventSource` + `<img>` tags that can't set Authorization headers).
- **Per-connection state lives in the SSE handler closure**, not the dispatcher. `handleAgentStream` receives `roomHydrator`, `roomSummariser`, `buildBriefing`, `seedBriefingSignature`, `kinds`, `agents`, `buildCap` via the dependency-injected `StreamsDeps` object; the dispatcher's `cap` shape doesn't need to grow to accommodate them.
- **`/stream` and `/agent-stream` ledger semantics:** `/stream` does not require ledger (it just replays the chatLog ring). `/agent-stream` internally checks `ledgerEnabled()` before running the kind-replay loop — kinds with no ledger have nothing to replay, so the connection still establishes. Neither route needs `requiresLedger: true` because the Ledger isn't a precondition for opening the SSE stream itself.
- **Adding a third long-lived route** (hypothetically: `/events` for raw event-log tailing) would also live in `hub/features/streams.ts` and follow the same wiring pattern. Not a HubFeature; not in the dispatcher.
- **Documented in `hub/core/dispatcher.ts`'s file-level comment** so future contributors understand why two routes don't appear in the dispatcher's compiled-route table.

## Recorded by

`architecture-cycle-2a` §4 (HubFeature dispatcher carve). The decision text reflects the choice already implemented in `hub/features/streams.ts` and `hub/hub.ts`'s `Bun.serve.fetch` block. The ADR file lands alongside the `feat(hub): HubFeature interface + dispatcher acceptance; carve hub.ts inline routes` commit.
