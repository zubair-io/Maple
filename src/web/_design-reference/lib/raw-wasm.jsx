// Wraps the wasm-pack output from src/raw-pipeline/raw-wasm.
//
// Strategy: load the ES module via a <script type="module"> tag in index.html
// that initialises the WASM binary and exposes the module as window.rawWasm,
// then fires a 'raw-wasm-ready' event. This avoids dynamic import() inside
// Babel-transpiled JSX (which doesn't work with Babel standalone's module
// handling).
//
// Usage:
//   await RawWasm.init();                          // resolves when WASM is ready
//   const r = await RawWasm.renderRaw(bytes, 'dng');
//   // r.width, r.height, r.rgb (Uint8Array, RGB, no alpha)

const RawWasm = (function () {
  let readyPromise = null;

  function init() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve, reject) => {
      if (window.rawWasm) {
        // Already initialised (module script ran before this code).
        resolve(window.rawWasm);
        return;
      }
      // Wait for the 'raw-wasm-ready' event fired by the module script.
      const onReady = () => {
        window.removeEventListener('raw-wasm-ready', onReady);
        if (window.rawWasm) {
          resolve(window.rawWasm);
        } else {
          reject(new Error('raw-wasm-ready fired but window.rawWasm is undefined'));
        }
      };
      window.addEventListener('raw-wasm-ready', onReady);
      // If the module script failed (e.g. pkg not built), surface the error
      // after a generous timeout rather than hanging silently.
      setTimeout(() => reject(new Error(
        'WASM init timeout — did you run wasm-pack build in src/raw-pipeline/raw-wasm?'
      )), 30000);
    });
    return readyPromise;
  }

  async function renderRaw(bytes, ext, xmp = null) {
    const mod = await init();
    // render_bytes returns a MapleRender JS object with getters width/height/rgb.
    const result = mod.render_bytes(bytes, ext, xmp);
    return {
      width: result.width,
      height: result.height,
      rgb: result.rgb,  // Uint8Array, RGB interleaved (no alpha)
    };
  }

  return { init, renderRaw };
})();

window.RawWasm = RawWasm;
