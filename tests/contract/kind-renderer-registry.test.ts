// Contract test — KindCardRenderer registry pattern is the single dispatch surface.
//
// After architecture-cycle-2b §1's registry carve, main.js's handleEvent + replay-
// on-connect helpers MUST NOT hardcode per-Kind branches. Adding a new Kind UI is
// (a) one new ui/kinds/<kind>.js file with its renderXxxCard + a
// KindCardRenderer.register(...) call, (b) one <script> tag in ui/index.html.
// main.js does not change.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("KindCardRenderer registry (post architecture-cycle-2b §1)", () => {
  test("main.js handleEvent has no hardcoded per-Kind dispatch branches", () => {
    const main = readFileSync(join(REPO_ROOT, "ui/main.js"), "utf8");
    // The pre-§1 pattern: `if (data.kind.startsWith('handoff.')) renderHandoffCard(data);` ×3
    expect(main).not.toMatch(/data\.kind\.startsWith\(['"]handoff\.['"]\)/);
    expect(main).not.toMatch(/data\.kind\.startsWith\(['"]interrupt\.['"]\)/);
    expect(main).not.toMatch(/data\.kind\.startsWith\(['"]permission\.['"]\)/);
    // The post-§1 pattern: registry dispatch
    expect(main).toMatch(/KindCardRenderer\.dispatch\(/);
  });

  test("main.js has no per-Kind replay-on-connect helpers", () => {
    const main = readFileSync(join(REPO_ROOT, "ui/main.js"), "utf8");
    // Pre-§1: three named const helpers (`const loadPendingHandoffs = ...` etc.)
    expect(main).not.toMatch(/loadPendingHandoffs\s*=\s*\(\)/);
    expect(main).not.toMatch(/loadPendingInterrupts\s*=\s*\(\)/);
    expect(main).not.toMatch(/loadPendingPermissions\s*=\s*\(\)/);
    // Post-§1: single loadAllPending alias delegating to the registry
    expect(main).toMatch(/KindCardRenderer\.loadAllPending\(\)/);
  });

  test("Each Kind file self-registers with KindCardRenderer.register", () => {
    const handoff = readFileSync(join(REPO_ROOT, "ui/kinds/handoff.js"), "utf8");
    const interrupt = readFileSync(join(REPO_ROOT, "ui/kinds/interrupt.js"), "utf8");
    const permission = readFileSync(join(REPO_ROOT, "ui/kinds/permission.js"), "utf8");

    // Each Kind must call register with the expected prefix
    expect(handoff).toMatch(/KindCardRenderer\.register\(/);
    expect(handoff).toMatch(/prefix:\s*['"]handoff['"]/);
    expect(handoff).toMatch(/loadPath:\s*['"]\/handoffs['"]/);

    expect(interrupt).toMatch(/KindCardRenderer\.register\(/);
    expect(interrupt).toMatch(/prefix:\s*['"]interrupt['"]/);
    expect(interrupt).toMatch(/loadPath:\s*['"]\/interrupts['"]/);

    expect(permission).toMatch(/KindCardRenderer\.register\(/);
    expect(permission).toMatch(/prefix:\s*['"]permission['"]/);
    expect(permission).toMatch(/loadPath:\s*['"]\/permissions['"]/);
  });

  test("index.html loads kind-renderer.js BEFORE per-Kind files", () => {
    const html = readFileSync(join(REPO_ROOT, "ui/index.html"), "utf8");
    const rendererPos = html.indexOf("kinds/kind-renderer.js");
    const handoffPos = html.indexOf("kinds/handoff.js");
    const interruptPos = html.indexOf("kinds/interrupt.js");
    const permissionPos = html.indexOf("kinds/permission.js");
    expect(rendererPos).toBeGreaterThan(-1);
    expect(rendererPos).toBeLessThan(handoffPos);
    expect(rendererPos).toBeLessThan(interruptPos);
    expect(rendererPos).toBeLessThan(permissionPos);
  });

  test("kind-renderer.js exposes the canonical registry API", () => {
    const renderer = readFileSync(join(REPO_ROOT, "ui/kinds/kind-renderer.js"), "utf8");
    expect(renderer).toMatch(/function register\(/);
    expect(renderer).toMatch(/function dispatch\(/);
    expect(renderer).toMatch(/function loadAllPending\(/);
    // Returns the API as { register, dispatch, loadAllPending } at minimum
    expect(renderer).toMatch(/return\s*\{[^}]*register[^}]*\}/s);
  });
});
