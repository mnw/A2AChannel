// http.js — HTTP helpers around the hub. Tier 1 (depends only on state.js
// for BUS/AUTH_TOKEN).
//
// authedFetch is the canonical path: bearer-token mutating routes + a
// transport-level retry that re-reads the hub URL from Tauri (handles the
// "hub restarted, port changed" recovery without forcing a webview reload).
//
// withToken / imgUrl handle read-only routes (EventSource, <img> src) which
// can't carry an Authorization header — fall back to ?token= query param.
//
// Exposes (as globals via classic-script lexical scope):
//   authedFetch, parseErrorBody, withToken, imgUrl
//   window.authedFetch — sibling modules (ui/usage.js) call this so they
//                         don't reimplement the token-rotation retry.

async function authedFetch(path, init = {}) {
  const build = () => {
    const h = { ...(init.headers || {}) };
    if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    return { url: `${BUS}${path}`, opts: { ...init, headers: h } };
  };
  const first = build();
  try {
    return await fetch(first.url, first.opts);
  } catch (err) {
    // Transport-level failure. Refresh hub info from Rust + retry once.
    const firstMsg = err?.message ?? String(err);
    const invoke =
      window.__TAURI_INTERNALS__?.invoke ||
      window.__TAURI__?.core?.invoke ||
      window.__TAURI__?.invoke;
    if (!invoke) {
      const e = new Error(`transport fail on ${first.url} (${firstMsg}); Tauri invoke unavailable`);
      throw e;
    }
    let refreshed = false;
    const oldBus = BUS;
    try {
      const info = await invoke('get_hub_url');
      if (info && typeof info === 'object') {
        if (typeof info.url === 'string' && info.url) BUS = info.url;
        if (typeof info.token === 'string') AUTH_TOKEN = info.token;
      } else if (typeof info === 'string' && info) {
        BUS = info;
      }
      refreshed = BUS !== oldBus;
    } catch (invokeErr) {
      const e = new Error(
        `transport fail on ${first.url} (${firstMsg}); get_hub_url failed: ${invokeErr?.message ?? invokeErr}`,
      );
      throw e;
    }
    const second = build();
    try {
      return await fetch(second.url, second.opts);
    } catch (retryErr) {
      const retryMsg = retryErr?.message ?? String(retryErr);
      const detail = refreshed
        ? `transport fail on ${first.url}; refreshed to ${BUS} and retry also failed (${retryMsg})`
        : `transport fail on ${first.url} (${firstMsg}); retry on ${BUS} also failed (${retryMsg})`;
      throw new Error(detail);
    }
  }
}
window.authedFetch = authedFetch;

async function parseErrorBody(r) {
  try {
    const body = await r.text();
    if (!body) return `HTTP ${r.status}`;
    try {
      const obj = JSON.parse(body);
      if (obj && typeof obj.error === 'string') return obj.error;
    } catch {}
    return body;
  } catch {
    return `HTTP ${r.status}`;
  }
}

function withToken(path) {
  if (!AUTH_TOKEN) return path;
  if (/[?&]token=/.test(path)) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(AUTH_TOKEN)}`;
}

function imgUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//.test(u)) return u;
  return `${BUS}${withToken(u)}`;
}
