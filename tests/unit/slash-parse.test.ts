// Unit tests for the pure functions in ui/features/slash-mode.js and
// ui/features/slash-discovery.js. These modules are classic <script>s that
// rely on globals (ROSTER, SELECTED_ROOM, etc.); we reach into them by
// reading the source file and eval'ing it inside a sandbox where we
// pre-populate the globals first.
//
// Functions covered here are PURE (no globals): parseSlashMessage,
// commandUnion, commandAvailability, formatSlashAuditText. Functions that
// touch globals (resolveTargets, busyAgents) are exercised by the manual
// smoke test in tasks.md §6.6 — DOM/Tauri mocking is heavyweight and the
// surface they wrap is small.

import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

function loadModule(
  relPath: string,
  sandbox: Record<string, unknown> = {},
  exportNames: string[] = []
) {
  const src = readFileSync(resolve(ROOT, relPath), "utf-8");
  // Materialize sandbox as `var` declarations at the top so the source's
  // free references resolve to the test-supplied stubs.
  const setupLines = Object.keys(sandbox).map((k) => `var ${k} = __sandbox__[${JSON.stringify(k)}];`);
  // After the source runs, collect the names the test asked for into the
  // returned object. The classic <script> declares them as plain `function`
  // / `const` at the top level — visible to a `new Function` body.
  const exportLines = exportNames
    .map((n) => `try { __out__[${JSON.stringify(n)}] = ${n}; } catch (e) {}`)
    .join("\n");
  const body = `${setupLines.join("\n")}\nconst __out__ = {};\n${src}\n${exportLines}\nreturn __out__;`;
  return new Function("__sandbox__", body)(sandbox);
}

let slashMode: any;
let slashDiscovery: any;
let slashSend: any;

beforeAll(() => {
  slashMode = loadModule(
    "ui/features/slash-mode.js",
    {
      input: { value: "" },
      ROSTER: [],
      SELECTED_ROOM: "__ALL__",
      ROOM_ALL: "__ALL__",
      presenceState: {},
      permissionCards: new Map(),
      interruptCards: new Map(),
    },
    ["isSlashMode", "parseSlashMessage", "resolveTargets", "busyAgents", "slashTargetCandidates"]
  );
  slashDiscovery = loadModule(
    "ui/features/slash-discovery.js",
    {
      ROSTER: [],
      SELECTED_ROOM: "__ALL__",
      ROOM_ALL: "__ALL__",
      presenceState: {},
      tauriInvoke: () => Promise.resolve([]),
    },
    [
      "BUILTIN_SLASH_COMMANDS",
      "DESTRUCTIVE_SLASH_COMMANDS",
      "discoverCommandsForAgent",
      "discoverCommandsForRoom",
      "commandUnion",
      "commandAvailability",
    ]
  );
  slashSend = loadModule(
    "ui/features/slash-send.js",
    {
      window: {},
      input: { value: "" },
      sendBtn: { disabled: false },
      HUMAN_NAME: "you",
      SELECTED_ROOM: "__ALL__",
      addMessage: () => {},
      parseSlashMessage: slashMode.parseSlashMessage,
      resolveTargets: () => ({ resolved: [], skipped: [] }),
      DESTRUCTIVE_SLASH_COMMANDS: new Set(),
      askConfirm: async () => true,
    },
    ["sendSlash", "formatSlashAuditText", "stripAnsi"]
  );
});

describe("stripAnsi (extended ANSI cases)", () => {
  test("removes ESC ( B charset selection", () => {
    const t = slashSend.stripAnsi("\x1B(Bplain text");
    expect(t).toBe("plain text");
  });
  test("removes ESC = and ESC > keypad mode toggles", () => {
    const t = slashSend.stripAnsi("\x1B=app\x1B>norm");
    expect(t).toBe("appnorm");
  });
  test("removes ESC 7 / ESC 8 cursor save/restore", () => {
    const t = slashSend.stripAnsi("\x1B7saved\x1B8");
    expect(t).toBe("saved");
  });
});

describe("stripAnsi", () => {
  test("removes CSI color codes", () => {
    const t = slashSend.stripAnsi("\x1B[31mred\x1B[0m text");
    expect(t).toBe("red text");
  });
  test("removes cursor moves and OSC sequences", () => {
    const t = slashSend.stripAnsi("\x1B[2J\x1B[H\x1B]0;title\x07hello");
    expect(t).toBe("hello");
  });
  test("normalizes CRLF and processes bare CR as in-place overwrite", () => {
    // CRLF → LF; bare CR moves cursor to col 0 of current line, the
    // following chars overwrite from there. "b\rc" → "c" (c overwrites b).
    // Matches terminal CR semantics — same byte-stream interpretation
    // claude relies on for progressive re-renders ([READY]\r[VERIFIED]).
    const t = slashSend.stripAnsi("a\r\nb\rc");
    expect(t).toBe("a\nc");
  });
  test("collapses 3+ blank lines to 2", () => {
    const t = slashSend.stripAnsi("a\n\n\n\nb");
    expect(t).toBe("a\n\nb");
  });
  test("returns empty for whitespace-only input", () => {
    expect(slashSend.stripAnsi("\x1B[2J   \n\n")).toBe("");
  });
});

describe("isSlashMode", () => {
  test("true when text starts with /", () => {
    expect(slashMode.isSlashMode("/")).toBe(true);
    expect(slashMode.isSlashMode("/clear")).toBe(true);
    expect(slashMode.isSlashMode("/clear @all")).toBe(true);
  });
  test("false when slash is not the first character", () => {
    expect(slashMode.isSlashMode("look at /etc/hosts")).toBe(false);
    expect(slashMode.isSlashMode(" /clear")).toBe(false);
  });
  test("false on empty / non-string", () => {
    expect(slashMode.isSlashMode("")).toBe(false);
    expect(slashMode.isSlashMode(null as any)).toBe(false);
  });
});

describe("parseSlashMessage", () => {
  test("returns nulls for non-slash text", () => {
    const r = slashMode.parseSlashMessage("hello @all");
    expect(r.slashCommand).toBeNull();
    expect(r.target).toBeNull();
    expect(r.args).toBe("");
  });

  test("parses /cmd alone", () => {
    const r = slashMode.parseSlashMessage("/clear");
    expect(r.slashCommand).toBe("/clear");
    expect(r.target).toBeNull();
    expect(r.args).toBe("");
  });

  test("parses /cmd @target args", () => {
    const r = slashMode.parseSlashMessage("/refactor @builder src/auth.ts");
    expect(r.slashCommand).toBe("/refactor");
    expect(r.target).toBe("builder");
    expect(r.args).toBe("src/auth.ts");
  });

  test("parses /cmd @all", () => {
    const r = slashMode.parseSlashMessage("/clear @all");
    expect(r.slashCommand).toBe("/clear");
    expect(r.target).toBe("all");
    expect(r.args).toBe("");
  });

  test("MCP-style command with double-underscores parses", () => {
    const r = slashMode.parseSlashMessage("/mcp__chatbridge__post @planner");
    expect(r.slashCommand).toBe("/mcp__chatbridge__post");
    expect(r.target).toBe("planner");
  });

  test("malformed @target is dropped from target slot", () => {
    const r = slashMode.parseSlashMessage("/cmd @bad/name foo");
    expect(r.slashCommand).toBe("/cmd");
    expect(r.target).toBeNull();
    // The malformed token falls through into args verbatim.
    expect(r.args).toContain("@bad/name");
  });
});

describe("commandUnion + commandAvailability", () => {
  test("union across agents preserves first non-empty description", () => {
    const map = new Map<string, Map<string, string>>([
      ["a", new Map([["/clear", "wipe context"], ["/refactor", "rewrite code"]])],
      ["b", new Map([["/clear", ""], ["/compact", "summarize"]])],
    ]);
    const u = slashDiscovery.commandUnion(map);
    expect(u.has("/clear")).toBe(true);
    expect(u.has("/refactor")).toBe(true);
    expect(u.has("/compact")).toBe(true);
    expect(u.size).toBe(3);
    expect(u.get("/clear")).toBe("wipe context");
    expect(u.get("/refactor")).toBe("rewrite code");
    expect(u.get("/compact")).toBe("summarize");
  });

  test("availability counts and missingFrom list", () => {
    const map = new Map<string, Map<string, string>>([
      ["a", new Map([["/clear", ""], ["/refactor", ""]])],
      ["b", new Map([["/clear", ""]])],
      ["c", new Map([["/clear", ""]])],
    ]);
    const all = slashDiscovery.commandAvailability("/clear", map);
    expect(all).toEqual({ available: 3, total: 3, missingFrom: [] });

    const refactor = slashDiscovery.commandAvailability("/refactor", map);
    expect(refactor).toEqual({ available: 1, total: 3, missingFrom: ["b", "c"] });
  });
});

describe("formatSlashAuditText", () => {
  test("no skipped", () => {
    const t = slashSend.formatSlashAuditText({
      slashCommand: "/clear",
      args: "",
      target: "all",
      resolved: ["planner", "builder"],
      skipped: [],
    });
    expect(t).toBe("human → /clear @all (planner, builder)");
  });

  test("with args and skipped", () => {
    const t = slashSend.formatSlashAuditText({
      slashCommand: "/refactor",
      args: "src/auth.ts",
      target: "builder",
      resolved: ["builder"],
      skipped: [{ name: "nebula", reason: "permission pending" }],
    });
    expect(t).toBe("human → /refactor src/auth.ts @builder (builder) — skipped: nebula (permission pending)");
  });

  test("nothing resolved still shows '(none)'", () => {
    const t = slashSend.formatSlashAuditText({
      slashCommand: "/help",
      args: "",
      target: "all",
      resolved: [],
      skipped: [{ name: "x", reason: "off" }],
    });
    expect(t).toContain("(none)");
    expect(t).toContain("skipped: x (off)");
  });
});
