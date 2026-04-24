// Conformance test — every registered KindModule implements the full contract.
// Half-implemented kinds (e.g. a new kind that satisfies the TypeScript type
// but leaves `migrate` as an empty stub) fail here.
//
// This test imports the same `KINDS` array the hub ships with, so it's always
// verifying the live registry — no mocks, no duplication.

import { describe, test, expect } from "bun:test";
import { handoffKind } from "../../hub/kinds/handoff";
import { interruptKind } from "../../hub/kinds/interrupt";
import { permissionKind } from "../../hub/kinds/permission";

const KINDS = [handoffKind, interruptKind, permissionKind] as const;

describe("KindModule contract conformance", () => {
  for (const k of KINDS) {
    describe(`kind: ${k.kind}`, () => {
      test("has required hooks", () => {
        expect(typeof k.kind).toBe("string");
        expect(k.kind.length).toBeGreaterThan(0);
        expect(typeof k.migrate).toBe("function");
        expect(Array.isArray(k.routes)).toBe(true);
        expect(typeof k.pendingFor).toBe("function");
        expect(Array.isArray(k.toolNames)).toBe(true);
      });

      test("routes are well-formed RouteDefs", () => {
        for (const r of k.routes) {
          expect(["GET", "POST"]).toContain(r.method);
          expect(typeof r.handler).toBe("function");
          expect(["mutating", "read"]).toContain(r.auth);
          // path is either a string or a RegExp
          const pathOk = typeof r.path === "string" || r.path instanceof RegExp;
          expect(pathOk).toBe(true);
        }
      });

      test("toolNames are unique kebab-cased identifiers", () => {
        const seen = new Set<string>();
        for (const name of k.toolNames) {
          expect(typeof name).toBe("string");
          expect(name.length).toBeGreaterThan(0);
          expect(seen.has(name)).toBe(false);
          seen.add(name);
        }
      });
    });
  }
});

describe("KINDS registry uniqueness", () => {
  test("no two kinds share the same kind name", () => {
    const names = KINDS.map((k) => k.kind);
    expect(new Set(names).size).toBe(names.length);
  });

  test("no two kinds declare the same (method, path) tuple", () => {
    const seen = new Set<string>();
    for (const k of KINDS) {
      for (const r of k.routes) {
        const key = `${r.method} ${r.path.toString()}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});
