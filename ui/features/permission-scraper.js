// permission-scraper.js — webview-side ghost-permission auto-dismissal.
//
// Wired via permission.js: every pending permission card calls
// permissionScraperWatch(); every transition off pending calls
// permissionScraperUnwatch(). The watcher composes ptyAwaitPattern (latch)
// + ptyAwaitPatternAbsent (debounce); on confirmation, POSTs to
// /permissions/<id>/dismiss-by-scraper which writes the snapshot file
// and dismisses the row with by_scraper=1.
//
// Fail-closed: 3 consecutive cards that fail to latch within 30s disable
// the scraper for the rest of the session. Manual × button still works.

const _SCRAPER_LATCH_GRACE_MS = 30_000;
const _SCRAPER_GHOST_WATCH_TIMEOUT_MS = 60_000;
const _SCRAPER_CONFIRMATIONS = 4;
const _SCRAPER_POLL_MS = 100;
const _SCRAPER_CIRCUIT_BREAKER = 3;

// Disjunction of selector shapes; at least one must be present in the
// pane along with the tool name (verified after match in JS).
const _SCRAPER_SELECTOR_PATTERN =
  "(Allow once|Allow forever|Don['’]t allow|\\(Y/n\\)|\\b[123]\\.\\s|[╭┌])";

let _scraperEnabled = null;       // fetched lazily; true | false | null
let _scraperDisabled = false;     // set after circuit-breaker trips this session
let _scraperFailures = 0;
const _scraperWatchers = new Map();

async function _scraperFlag() {
  if (_scraperEnabled !== null) return _scraperEnabled;
  try {
    _scraperEnabled = !!(await tauriInvoke('get_permission_scraper_enabled'));
  } catch (e) {
    console.warn('[scraper] flag query failed:', e);
    _scraperEnabled = false;
  }
  return _scraperEnabled;
}

function _scraperLog(line) {
  console.log(line);
}

async function permissionScraperWatch(id, agent, room, toolName) {
  if (!await _scraperFlag()) return;
  if (_scraperDisabled) return;
  if (_scraperWatchers.has(id)) return;
  if (!agent || !toolName) return;

  const slot = { agent, room, toolName, cancelled: false };
  _scraperWatchers.set(id, slot);
  _runScraper(id, slot).catch((e) => _scraperLog(`[scraper] perm_id=${id} crash: ${e?.message ?? e}`));
}

function permissionScraperUnwatch(id) {
  const slot = _scraperWatchers.get(id);
  if (slot) {
    slot.cancelled = true;
    _scraperWatchers.delete(id);
  }
}

async function _runScraper(id, slot) {
  const pty = window.__A2A_TERM__?.pty;
  if (!pty?.ptyAwaitPattern || !pty?.ptyAwaitPatternAbsent) {
    _scraperLog(`[scraper] perm_id=${id} skipped — pty bridge unavailable`);
    return;
  }

  // Phase 1: latch.
  let latch;
  try {
    latch = await pty.ptyAwaitPattern(slot.agent, _SCRAPER_SELECTOR_PATTERN, _SCRAPER_LATCH_GRACE_MS, _SCRAPER_POLL_MS);
  } catch (e) {
    _scraperLog(`[scraper] perm_id=${id} latch invoke failed: ${e?.message ?? e}`);
    _scraperWatchers.delete(id);
    return;
  }
  if (slot.cancelled) return;

  const seenToolName = latch.last_snapshot.includes(slot.toolName);
  if (!latch.matched || !seenToolName) {
    _scraperFailures += 1;
    _scraperLog(
      `[scraper] perm_id=${id} LATCH_GRACE_MS expired — gave up ` +
      `(toolNameSeen=${seenToolName} selectorSeen=${latch.matched})`,
    );
    if (_scraperFailures >= _SCRAPER_CIRCUIT_BREAKER) {
      _scraperDisabled = true;
      _scraperLog(
        `[scraper] disabled — ${_scraperFailures} consecutive cards never reached SEEN_DIALOG. ` +
        `Manual × button still works; restart hub to re-enable.`,
      );
    }
    _scraperWatchers.delete(id);
    return;
  }
  _scraperFailures = 0;
  _scraperLog(`[scraper] perm_id=${id} PENDING → SEEN_DIALOG (matched=${latch.matched_text}, tool=${slot.toolName})`);

  // Phase 2: ghost-watch.
  let absent;
  try {
    absent = await pty.ptyAwaitPatternAbsent(
      slot.agent,
      _SCRAPER_SELECTOR_PATTERN,
      _SCRAPER_GHOST_WATCH_TIMEOUT_MS,
      _SCRAPER_CONFIRMATIONS,
      _SCRAPER_POLL_MS,
    );
  } catch (e) {
    _scraperLog(`[scraper] perm_id=${id} ghost-watch invoke failed: ${e?.message ?? e}`);
    _scraperWatchers.delete(id);
    return;
  }
  if (slot.cancelled) return;

  if (!absent.matched) {
    _scraperLog(`[scraper] perm_id=${id} GHOST_WATCH timeout — gave up`);
    _scraperWatchers.delete(id);
    return;
  }

  // Phase 3: file dismissal via the hub. POST writes snapshot + flips status.
  try {
    const r = await authedFetch(`/permissions/${encodeURIComponent(id)}/dismiss-by-scraper`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: HUMAN_NAME, snapshot: absent.last_snapshot }),
    });
    if (!r.ok) {
      _scraperLog(`[scraper] perm_id=${id} dismiss-by-scraper HTTP ${r.status}`);
    } else {
      _scraperLog(`[scraper] perm_id=${id} GHOST_WATCH → AUTO_DISMISSED (elapsed=${absent.elapsed_ms}ms)`);
    }
  } catch (e) {
    _scraperLog(`[scraper] perm_id=${id} dismiss-by-scraper failed: ${e?.message ?? e}`);
  } finally {
    _scraperWatchers.delete(id);
  }
}
