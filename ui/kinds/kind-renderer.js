// kind-renderer.js — registry pattern for Webview Kind dispatch.
//
// Each Kind self-registers (handoff.js / interrupt.js / permission.js call
// `KindCardRenderer.register(...)` at file load). main.js consults the registry
// for SSE event dispatch + replay-on-connect loading — no hardcoded per-Kind
// branches in main.js.
//
// Loaded as a classic <script> BEFORE the per-Kind files (which depend on the
// `KindCardRenderer` global being available at module-load time for their
// self-registration calls).
//
// Adding a new Kind UI = create ui/kinds/<kind>.js with its renderXxxCard
// implementation + the KindCardRenderer.register(...) call. Add the script
// tag to ui/index.html in the kind-load section. main.js does NOT change.
//
// Architecture-cycle-2b §1 ships this as a registry-only carve. ES-module
// migration (replacing the classic-<script> shared-lexical-scope arrangement)
// is intentionally deferred — would require migrating every UI file because
// today's globals (messagesEl, authedFetch, parseErrorBody, askReason, escHtml,
// HUMAN_NAME, addMessage, trimMessages, SELECTED_ROOM, input, sendBtn, etc.)
// are shared across composer.js, slash-command.js, rooms.js, mentions.js,
// attachments.js. Partial migration is not feasible — it's all-or-nothing.
// Filed in docs/architecture/known-friction.md if it becomes a feature need.

const KindCardRenderer = (() => {
  /**
   * @typedef {Object} KindAdapter
   * @property {string} prefix - Kind name (event kinds match `${prefix}.*`)
   * @property {string} loadPath - Hub endpoint that lists pending entries on reconnect
   * @property {(snapshot: any) => any} toLoadEventShape - Snapshot → event-shape mapper for replay
   * @property {(event: any) => void} render - Render function (existing renderXxxCard)
   */

  /** @type {KindAdapter[]} */
  const adapters = [];

  /**
   * Register a Kind. Throws if adapter is malformed (mis-spelled property names
   * fail at registration, not later at dispatch time).
   * @param {KindAdapter} adapter
   */
  function register(adapter) {
    if (
      typeof adapter !== 'object' ||
      adapter === null ||
      typeof adapter.prefix !== 'string' || !adapter.prefix.length ||
      typeof adapter.loadPath !== 'string' || !adapter.loadPath.length ||
      typeof adapter.toLoadEventShape !== 'function' ||
      typeof adapter.render !== 'function'
    ) {
      throw new Error(
        `KindCardRenderer.register: invalid adapter (expected {prefix, loadPath, toLoadEventShape, render}); got ${JSON.stringify(Object.keys(adapter ?? {}))}`,
      );
    }
    if (adapters.some((a) => a.prefix === adapter.prefix)) {
      throw new Error(`KindCardRenderer.register: prefix "${adapter.prefix}" already registered`);
    }
    adapters.push(adapter);
  }

  /**
   * Dispatch an SSE event to the matching Kind renderer. Returns true if a
   * renderer handled it, false otherwise (caller falls through to addMessage).
   * @param {string} kind
   * @param {any} event
   * @returns {boolean}
   */
  function dispatch(kind, event) {
    if (typeof kind !== 'string') return false;
    for (const a of adapters) {
      if (kind.startsWith(`${a.prefix}.`)) {
        a.render(event);
        return true;
      }
    }
    return false;
  }

  /**
   * Replay-on-connect: iterates every registered Kind's loadPath via the
   * existing `loadPending` helper from main.js. Errors are logged + skipped
   * per-Kind (one failing endpoint doesn't block the others).
   */
  async function loadAllPending() {
    for (const a of adapters) {
      try {
        // `loadPending` is a main.js global — present at this call site since
        // loadAllPending() is invoked from main.js after main.js has defined it.
        await loadPending(a.loadPath, a.toLoadEventShape, a.render);
      } catch (e) {
        console.warn(`[kind-renderer] loadPending ${a.loadPath} failed:`, e);
      }
    }
  }

  /** Read-only inspection for tests. */
  function _registeredPrefixes() {
    return adapters.map((a) => a.prefix).slice();
  }

  return { register, dispatch, loadAllPending, _registeredPrefixes };
})();
