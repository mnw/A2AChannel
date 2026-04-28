// usage.js — header pill showing plan budget usage; banner-scrape > transcript USD > empty.

(function usagePill() {
  const POLL_MS = 60_000;
  const RENDER_TICK_MS = 60_000;
  const BANNER_KEY = 'a2achannel_usage_banner';

  const sessionEl = document.getElementById('usage-session');
  const weeklyEl  = document.getElementById('usage-weekly');
  if (!sessionEl || !weeklyEl) return;
  const sessionPctEl   = sessionEl.querySelector('.usage-pct');
  const sessionResetEl = sessionEl.querySelector('.usage-reset');
  const weeklyPctEl    = weeklyEl.querySelector('.usage-pct');
  const weeklyResetEl  = weeklyEl.querySelector('.usage-reset');

  let transcriptSnapshot = null;
  let bannerSnapshot = null;
  try {
    const raw = localStorage.getItem(BANNER_KEY);
    if (raw) bannerSnapshot = JSON.parse(raw);
  } catch {}

  // Without the nF/SCS clause, claude's Ink charset-switch escapes leave "(B" garbage in the buffer.
  const ANSI_ESCAPE_RE =
    /\x1b(?:\[[0-9;?]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[\x20-\x2F]+[\x30-\x7E]|[@-Z\\-_])/g;
  const usageDecoder = new TextDecoder('utf-8', { fatal: false });
  // 128 KB needed: /usage raw is 30–50 KB and "Current session" appears before "Current week".
  const TAIL_MAX = 131_072;
  // Ink uses cursor-forward escapes for layout, not literal spaces; post-strip there's no whitespace.
  const SESSION_RE =
    /Current\s*session[\s\S]*?(\d{1,3})\s*%\s*used[\s\S]*?Resets\s*([^\r\n]+?)(?=\s*(?:Current|\r|\n|$))/i;
  const WEEKLY_RE =
    /Current\s*week\s*\(\s*all\s*models\s*\)[\s\S]*?(\d{1,3})\s*%\s*used[\s\S]*?Resets\s*([^\r\n]+?)(?=\s*(?:Current|\r|\n|$))/i;
  const SONNET_RE =
    /Current\s*week\s*\(\s*Sonnet\s*only\s*\)[\s\S]*?(\d{1,3})\s*%\s*used/i;
  const COST_RE = /Total\s*cost:\s*\$?([\d,]+\.?\d*)/i;

  // Wall-clock interpreted in user's local timezone (matches what claude prints).
  function parseResetTime(raw) {
    if (!raw) return null;
    const text = raw.trim().replace(/\s+/g, ' ');
    const noTz = text.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const now = new Date();
    let m = noTz.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (m) {
      let h = Number(m[1]) % 12;
      if (m[3].toLowerCase() === 'pm') h += 12;
      const mins = m[2] ? Number(m[2]) : 0;
      const target = new Date(now);
      target.setHours(h, mins, 0, 0);
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
      return target.getTime();
    }
    // Ink strips whitespace; every separator is optional.
    m = noTz.match(/^([A-Z][a-z]{2})\s*(\d{1,2})(?:\s*at)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (m) {
      const monthStr = m[1];
      const day = Number(m[2]);
      let h = Number(m[3]);
      const mins = m[4] ? Number(m[4]) : 0;
      const ampm = m[5];
      if (ampm) { h = h % 12; if (ampm.toLowerCase() === 'pm') h += 12; }
      const target = new Date(`${monthStr} ${day} ${now.getFullYear()} ${h}:${String(mins).padStart(2, '0')}:00`);
      if (Number.isFinite(target.getTime())) {
        if (target.getTime() <= now.getTime()) target.setFullYear(now.getFullYear() + 1);
        return target.getTime();
      }
    }
    const parsed = Date.parse(noTz);
    if (Number.isFinite(parsed) && parsed > now.getTime()) return parsed;
    return null;
  }

  // Inspect via window.A2A_USAGE._debug.tails['<agent>'] when the regex doesn't match.
  const DEBUG_TAIL_MAX = 8_192;
  const _debug = { tails: {}, captureCount: 0, matchCount: 0 };

  function captureBanner(state, agent, chunkBytes) {
    state.usageTail = (state.usageTail || '') + usageDecoder.decode(chunkBytes, { stream: true });
    if (state.usageTail.length > TAIL_MAX) state.usageTail = state.usageTail.slice(-TAIL_MAX);
    const clean = state.usageTail.replace(ANSI_ESCAPE_RE, '');
    _debug.captureCount += 1;
    _debug.tails[agent] = clean.slice(-DEBUG_TAIL_MAX);
    const sm = SESSION_RE.exec(clean);
    const wm = WEEKLY_RE.exec(clean);
    if (!sm && !wm) {
      // Loud signal: section header seen but regex didn't match — adjust the regex.
      if (/Current\s+session/i.test(clean) || /Current\s+week/i.test(clean)) {
        console.warn(`[A2A_USAGE] /usage text seen on "${agent}" but regex didn't match. ` +
          `Inspect window.A2A_USAGE._debug.tails["${agent}"]`);
      }
      return;
    }
    _debug.matchCount += 1;
    // Merge into pinned snapshot; never clobber. A single chunk may carry only weekly OR session.
    const snap = {
      ...(bannerSnapshot || {}),
      capturedAtMs: Date.now(),
      sourceAgent: agent,
    };
    if (sm) {
      snap.session = {
        pct: Number(sm[1]),
        resetAtMs: parseResetTime(sm[2]),
        resetText: sm[2].trim(),
      };
    }
    if (wm) {
      snap.weekly = {
        pct: Number(wm[1]),
        resetAtMs: parseResetTime(wm[2]),
        resetText: wm[2].trim(),
      };
    }
    const sonnet = SONNET_RE.exec(clean);
    if (sonnet) snap.weeklySonnetPct = Number(sonnet[1]);
    const cost = COST_RE.exec(clean);
    if (cost) snap.totalCostUsd = Number(cost[1].replace(/,/g, ''));
    bannerSnapshot = snap;
    try { localStorage.setItem(BANNER_KEY, JSON.stringify(snap)); } catch {}
    render();
    // Rewind past matched region so we don't re-fire on every byte.
    const furthest = Math.max(
      sm ? sm.index + sm[0].length : 0,
      wm ? wm.index + wm[0].length : 0,
    );
    if (furthest > 0) state.usageTail = state.usageTail.slice(furthest);
  }

  function formatUsd(n) {
    if (!Number.isFinite(n) || n <= 0) return '$0';
    if (n >= 100) return `$${n.toFixed(0)}`;
    if (n >= 10)  return `$${n.toFixed(1)}`;
    return `$${n.toFixed(2)}`;
  }
  function formatCountdown(targetMs) {
    const remaining = targetMs - Date.now();
    if (remaining <= 0) return 'resets: now';
    const mins = Math.floor(remaining / 60_000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `resets: ${h}h ${m}m` : `resets: ${m}m`;
  }
  // Reverse Ink's whitespace-stripped layout: "Apr30at4pm(Europe/Brussels)" → "Apr 30 at 4 pm".
  function humanizeResetText(s) {
    return s
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/(\d)([A-Za-z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2')
      .replace(/(\d)\s*(am|pm)\b/gi, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function formatAbsoluteReset(ms, fallbackText) {
    if (Number.isFinite(ms) && ms > 0) {
      // Prefer the absolute clock claude printed over a "resets: 4h 12m" countdown.
      if (fallbackText) return `resets: ${humanizeResetText(fallbackText)}`;
      return formatCountdown(ms);
    }
    return fallbackText ? `resets: ${humanizeResetText(fallbackText)}` : 'no data';
  }
  function levelFromPct(pct) {
    if (pct >= 90) return 'danger';
    if (pct >= 75) return 'warn';
    return null;
  }
  function modelBreakdownTitle(byModel) {
    if (!byModel) return '';
    const lines = Object.entries(byModel)
      .sort((a, b) => b[1].costUsd - a[1].costUsd)
      .map(([m, v]) => `  ${m}: ${formatUsd(v.costUsd)} (${v.tokens.toLocaleString()} tok)`);
    return lines.length ? '\nBy model:\n' + lines.join('\n') : '';
  }

  // Pinned until reset time crosses or user re-runs /usage; % only rises between resets.
  function bannerStillFresh(snap, scope) {
    if (!snap || !snap[scope]) return false;
    const reset = snap[scope].resetAtMs;
    if (Number.isFinite(reset) && reset <= Date.now()) return false;
    return true;
  }

  function renderChip(el, pctEl, resetEl, opts) {
    if (opts.empty) {
      el.dataset.empty = '1';
      delete el.dataset.level;
      delete el.dataset.stale;
      pctEl.textContent = '—';
      resetEl.textContent = opts.resetText || 'no data';
      el.title = opts.title || '';
      return;
    }
    delete el.dataset.empty;
    if (opts.level) el.dataset.level = opts.level;
    else delete el.dataset.level;
    if (opts.stale) el.dataset.stale = '1';
    else delete el.dataset.stale;
    pctEl.textContent = opts.headline;
    resetEl.textContent = opts.resetText;
    el.title = opts.title || '';
  }

  function render() {
    if (bannerStillFresh(bannerSnapshot, 'session')) {
      const s = bannerSnapshot.session;
      const level = levelFromPct(s.pct);
      const cost = bannerSnapshot.totalCostUsd ? ` · ${formatUsd(bannerSnapshot.totalCostUsd)}` : '';
      renderChip(sessionEl, sessionPctEl, sessionResetEl, {
        headline: `${s.pct}% used`,
        resetText: formatAbsoluteReset(s.resetAtMs, s.resetText),
        level,
        title:
          `Current session: ${s.pct}% used${cost}\n` +
          `Resets ${s.resetText}\n` +
          `Captured from ${bannerSnapshot.sourceAgent ?? 'unknown'} at ${new Date(bannerSnapshot.capturedAtMs).toLocaleTimeString()}.\n` +
          'Run /usage in any embedded claude pane to refresh.',
      });
    } else if (transcriptSnapshot && transcriptSnapshot.session.active) {
      const s = transcriptSnapshot.session;
      renderChip(sessionEl, sessionPctEl, sessionResetEl, {
        headline: formatUsd(s.totalCostUsd),
        resetText: s.blockEndMs ? formatCountdown(s.blockEndMs) : 'no data',
        title:
          `Active 5-hour block: ${formatUsd(s.totalCostUsd)} (${s.totalTokens.toLocaleString()} tokens) across all claudes on this machine.\n` +
          'Run /usage in an embedded claude pane to see real % of plan.' +
          modelBreakdownTitle(s.byModel),
      });
    } else if (transcriptSnapshot) {
      renderChip(sessionEl, sessionPctEl, sessionResetEl, {
        empty: true,
        resetText: 'idle',
        title: 'No active session block. A new 5-hour window starts on your next claude message.',
      });
    } else {
      renderChip(sessionEl, sessionPctEl, sessionResetEl, {
        empty: true,
        title: 'Use any claude session on this machine to populate.',
      });
    }

    if (bannerStillFresh(bannerSnapshot, 'weekly')) {
      const w = bannerSnapshot.weekly;
      const level = levelFromPct(w.pct);
      const sonnetSuffix = bannerSnapshot.weeklySonnetPct !== undefined
        ? `\nSonnet only: ${bannerSnapshot.weeklySonnetPct}% used`
        : '';
      renderChip(weeklyEl, weeklyPctEl, weeklyResetEl, {
        headline: `${w.pct}%`,
        resetText: formatAbsoluteReset(w.resetAtMs, w.resetText),
        level,
        title: `Current week (all models): ${w.pct}% used\nResets ${w.resetText}${sonnetSuffix}`,
      });
    } else if (transcriptSnapshot) {
      const w = transcriptSnapshot.weekly;
      renderChip(weeklyEl, weeklyPctEl, weeklyResetEl, {
        headline: formatUsd(w.totalCostUsd),
        resetText: 'last 7d',
        title:
          `Rolling 7-day total: ${formatUsd(w.totalCostUsd)} (${w.totalTokens.toLocaleString()} tokens) across all claudes on this machine.` +
          modelBreakdownTitle(w.byModel),
      });
    } else {
      renderChip(weeklyEl, weeklyPctEl, weeklyResetEl, {
        empty: true,
        title: 'Use any claude session on this machine to populate.',
      });
    }
  }

  async function refresh() {
    try {
      if (typeof window.authedFetch !== 'function') return;
      const r = await window.authedFetch('/usage');
      if (!r.ok) return;
      transcriptSnapshot = await r.json();
      render();
    } catch {
      // Silent: pill stays on last paint through transport hiccups.
    }
  }

  for (const [el, scope] of [[sessionEl, 'session'], [weeklyEl, 'weekly']]) {
    el.addEventListener('click', () => {
      if (bannerStillFresh(bannerSnapshot, scope)) {
        const s = bannerSnapshot[scope];
        navigator.clipboard?.writeText(`${s.pct}% · ${formatAbsoluteReset(s.resetAtMs, s.resetText)}`);
        return;
      }
      if (!transcriptSnapshot) return;
      const t = scope === 'session' ? transcriptSnapshot.session : transcriptSnapshot.weekly;
      const tail = scope === 'session' && t.blockEndMs ? formatCountdown(t.blockEndMs) : 'last 7d';
      navigator.clipboard?.writeText(`${formatUsd(t.totalCostUsd)} · ${tail}`);
    });
  }

  window.A2A_USAGE = { captureBanner, _debug };

  setInterval(render, RENDER_TICK_MS);
  setInterval(refresh, POLL_MS);
  render();
  refresh();
})();
