# Name the parent contract for route-owning Hub units `HubFeature`

`architecture-cycle-2a` generalizes `KindModule.routes` into a parent contract so non-Kind units (chat, transcript, attachments, sessions, usage, Roster, streams) can also live as carved-out files under `hub/features/` and feed the same dispatcher. The shape is settled: `HubFeature = { routes: RouteDef[] }`, `KindModule` extends it via TypeScript structural subtyping, the dispatcher consumes `HubFeature[]`, the briefing aggregator filters for the Kind subtype by duck-typing on `toolNames`. The pre-grill (1.2) settled the only open question: the **name** of the parent type.

## Considered Options

- **`Surface`**: rejected. Collides with industry-standard "API surface" / "attack surface." LANGUAGE.md uses **Interface**, not "surface," so the claimed vocabulary tie-in is thin. Reads poorly in prose ("a list of Surfaces").
- **`RouteHost`**: rejected. Descriptive but mechanical; "host" is unused in our vocabulary, which is good for collisions but bad for discoverability. Less quotable than `HubFeature` in spec docs.
- **`Module`**: rejected. Clashes head-on with LANGUAGE.md's core term. Every `HubFeature` is a Module, but naming a thing after its category robs both terms of precision.
- **`HubModule`**: rejected for the same reason as `Module`, plus "Hub" + "Module" reads as redundant when the file path already says `hub/`.

## Consequences

- **The parent type is `HubFeature`,** defined in `hub/core/types.ts` as `export type HubFeature = { routes: RouteDef[] }`. `KindModule` is redefined as `HubFeature & { entity: LedgerEntity<Snapshot>; pendingFor; toolNames; priority?; kind: string }`. The dispatcher signature becomes `register(features: HubFeature[])`.
- **The CONTEXT.md Glossary entry lives under "State-machines"** immediately before **Kind**, so readers encounter the parent before the specialization. The entry includes a definition line, a cross-reference to **Hub** and **Kind** and **Roster**, and an `_Avoid_:` line fencing off `module`, `service`, `endpoint`, `plugin` with reasons.
- **The dispatcher and briefing aggregator stay kind-agnostic.** New non-Kind features are added by dropping a file under `hub/features/<name>.ts` exporting a `HubFeature` and appending to the `FEATURES` array in `hub/hub.ts`. No edits to `hub.ts`'s dispatcher logic or the briefing builder are required.
- **`KindModule` survives as a named alias for the Kind-specialized intersection** — existing references to it in `hub/kinds/*.ts` and in CLAUDE.md's hard rules don't churn. The narrative "every Kind is a HubFeature" is structural via TypeScript's subtyping, not a runtime tag.
- **LANGUAGE.md is untouched.** Module remains the architecture-vocabulary term; `HubFeature` is project-domain. CONTEXT.md is the home for the project term, which is the right separation.
- **Tooling implications:** `grep "HubFeature"` is a clean discriminator across the codebase (no industry-shared collision). Future PR descriptions and commit messages MUST use `HubFeature`, not "module" / "service" / "feature module" / "endpoint" / "plugin," when referring to this type.

## Recorded by

`architecture-cycle-2a`, pre-grill task 1.2 (closed 2026-05-10). The ADR file lands alongside the `feat(hub): HubFeature interface + dispatcher acceptance; carve hub.ts inline routes` commit in §4 of the cycle's task list.
