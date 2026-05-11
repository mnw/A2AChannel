// Registry: per-Kind <script> files self-register via KindCardRenderer.register(...).
// Main.js consults the registry for SSE dispatch + replay-on-connect. Load BEFORE per-Kind files.

const KindCardRenderer = (() => {
  /** @type {{prefix:string,loadPath:string,toLoadEventShape:(s:any)=>any,render:(e:any)=>void}[]} */
  const adapters = [];

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

  async function loadAllPending() {
    for (const a of adapters) {
      try {
        await loadPending(a.loadPath, a.toLoadEventShape, a.render);
      } catch (e) {
        console.warn(`[kind-renderer] loadPending ${a.loadPath} failed:`, e);
      }
    }
  }

  function _registeredPrefixes() {
    return adapters.map((a) => a.prefix).slice();
  }

  return { register, dispatch, loadAllPending, _registeredPrefixes };
})();
