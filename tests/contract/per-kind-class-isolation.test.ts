// Contract test — no per-Kind class SELECTORS exist outside ui/styles/kinds.css.
//
// After architecture-cycle-2b §2's CSS consolidation + [data-kind] migration,
// per-Kind visual rules live in exactly one place. The selectors `.handoff-card`,
// `.interrupt-card`, `.permission-card` MUST NOT appear in any other CSS file,
// in ui/index.html, or in JS-emitted CSS (e.g. ui/features/rooms.js's
// runtime-injected room-filter rule).
//
// Per-Kind class names CAN still appear in JS as `el.className = 'handoff-card'`
// (the buildXxxCardDom path still sets the class for backward compatibility +
// non-CSS uses like debug inspection). This test gates SELECTOR usage only —
// not className assignment.

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const KIND_CLASS_SELECTOR_PATTERN =
  /\.(handoff-card|interrupt-card|permission-card)(?![a-zA-Z0-9_-])/;

function walk(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

describe("per-Kind class isolation (post architecture-cycle-2b §2)", () => {
  test("CSS files outside ui/styles/kinds.css contain no per-Kind class selectors", () => {
    const cssFiles = walk(join(REPO_ROOT, "ui"), [".css"]);
    const offenders: string[] = [];
    for (const f of cssFiles) {
      if (f.endsWith("ui/styles/kinds.css")) continue;
      const content = readFileSync(f, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (KIND_CLASS_SELECTOR_PATTERN.test(line)) {
          offenders.push(`${f}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    if (offenders.length > 0) {
      console.error("Per-Kind class selectors found outside kinds.css:\n" + offenders.join("\n"));
    }
    expect(offenders).toEqual([]);
  });

  test("JS files emitting CSS at runtime do not hardcode per-Kind class selectors", () => {
    // Today's only known JS-injected CSS site is ui/features/rooms.js. It MUST use
    // [data-kind][data-room] selectors instead of .handoff-card[data-room] etc.
    const jsFiles = walk(join(REPO_ROOT, "ui"), [".js"]);
    const offenders: string[] = [];
    for (const f of jsFiles) {
      const content = readFileSync(f, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        // Match the per-Kind class names followed by an attribute selector or pseudo-class —
        // shape that strongly indicates a CSS selector inside a template string.
        // Tolerates the buildXxxCardDom-style className assignment `el.className = 'X-card'`
        // by checking the next char is '[' or ':' or '.' or ' ' (selector continuation).
        if (/\.(handoff-card|interrupt-card|permission-card)(\[|:|\s+\{|\.)/.test(line)) {
          offenders.push(`${f}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    if (offenders.length > 0) {
      console.error("JS-emitted CSS selectors hardcoding per-Kind class names:\n" + offenders.join("\n"));
    }
    expect(offenders).toEqual([]);
  });

  test("ui/styles/kinds.css uses [data-kind] selectors for card-root rules", () => {
    const content = readFileSync(join(REPO_ROOT, "ui/styles/kinds.css"), "utf8");
    // Sanity check the consolidated file has the migrated selectors
    expect(content).toContain('[data-kind="handoff"]');
    expect(content).toContain('[data-kind="interrupt"]');
    expect(content).toContain('[data-kind="permission"]');
  });

  test("Each Kind JS sets el.dataset.kind on the card root", () => {
    const handoff = readFileSync(join(REPO_ROOT, "ui/kinds/handoff.js"), "utf8");
    const interrupt = readFileSync(join(REPO_ROOT, "ui/kinds/interrupt.js"), "utf8");
    const permission = readFileSync(join(REPO_ROOT, "ui/kinds/permission.js"), "utf8");
    expect(handoff).toMatch(/dataset\.kind\s*=\s*['"]handoff['"]/);
    expect(interrupt).toMatch(/dataset\.kind\s*=\s*['"]interrupt['"]/);
    expect(permission).toMatch(/dataset\.kind\s*=\s*['"]permission['"]/);
  });
});
