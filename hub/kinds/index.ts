// Kind registry — adding a Kind = one import + one array entry HERE.
// hub.ts iterates `KIND_FACTORIES` to construct the `KINDS` array; no edit to hub.ts
// is required for new Kinds (per kind-runtime/spec.md "Adding a kind is a single-file
// change").

import type { Database } from "bun:sqlite";
import type { KindModule } from "../core/types";
import { createHandoffKind } from "./handoff";
import { createInterruptKind } from "./interrupt";
import { createPermissionKind } from "./permission";

export type KindFactory = (db: Database) => KindModule;

export const KIND_FACTORIES: readonly KindFactory[] = [
  createHandoffKind,
  createInterruptKind,
  createPermissionKind,
];

/** Construct all Kinds against the live ledger db. Empty array when ledger disabled. */
export function buildKinds(db: Database | null): readonly KindModule[] {
  if (!db) return [];
  return KIND_FACTORIES.map((f) => f(db));
}
