#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_SOURCE="$(cd "$WORKSPACE_ROOT/../raw-pipeline/raw-wasm/pkg" && pwd)"
PKG_DEST="$WORKSPACE_ROOT/projects/maple-common/src/lib/raw-pipeline/pkg"

if [ ! -d "$PKG_SOURCE" ]; then
  echo "ERROR: $PKG_SOURCE does not exist. Run src/raw-pipeline/scripts/build-raw-wasm.sh first." >&2
  echo "       (wasm-bindgen-rayon needs --features parallel + -Z build-std flags;" >&2
  echo "        the helper script wraps the canonical wasm-pack invocation.)" >&2
  exit 1
fi

mkdir -p "$(dirname "$PKG_DEST")"
rm -rf "$PKG_DEST"
cp -R "$PKG_SOURCE" "$PKG_DEST"
echo "Synced raw-wasm pkg/ -> projects/maple-common/src/lib/raw-pipeline/pkg/"

# ---------------------------------------------------------------------------
# wasm-bindgen-rayon nested-worker patch (#2097)
# ---------------------------------------------------------------------------
# wasm-bindgen-rayon self-spawns its thread-pool workers with
#   new Worker(new URL('./workerHelpers.js', import.meta.url), { type: 'module' })
# from inside the render worker. The Angular/esbuild bundler folds
# workerHelpers.js into the render-worker chunk (it is also statically imported
# for `startWorkers`) and — unlike Vite — does NOT re-emit or rewrite a
# `new Worker(new URL())` that lives inside a worker bundle (a nested worker).
# So at runtime `import.meta.url` is the chunk URL at the server root and the
# spawn resolves to `/workerHelpers.js`, which 404s in BOTH the dev server and
# the src/api production static server. `initThreadPool` then times out and
# every session silently falls back to single-threaded.
#
# Fix: spawn a dedicated worker-side entry by an ABSOLUTE, hash-free served URL
# (`/pkg/workerHelpers.worker.js`) that both servers actually return, and let
# that entry load the glue at runtime (`./raw_wasm.js`) rather than at bundle
# time. The compiled module + shared memory are handed in via postMessage, so
# no second wasm fetch happens. `/pkg/workerHelpers.worker.js` and
# `/pkg/raw_wasm.js` are published by the `assets` globs in angular.json.
#
# This runs on every sync because pkg/ is gitignored and regenerated, so the
# patch must live here (a committed pkg edit would be silently overwritten).
# The guard below aborts if wasm-bindgen-rayon's generated layout changes, so a
# version bump can't quietly reland the single-threaded fallback.
python3 - "$PKG_DEST" <<'PYEOF'
import pathlib, sys

pkg = pathlib.Path(sys.argv[1])

snippets = sorted(pkg.glob("snippets/wasm-bindgen-rayon-*/src/workerHelpers.js"))
if len(snippets) != 1:
    sys.exit(
        f"ERROR (#2097 patch): expected exactly one wasm-bindgen-rayon "
        f"workerHelpers.js under {pkg}/snippets, found {len(snippets)}. "
        f"wasm-bindgen-rayon layout changed — review the patch."
    )
snippet = snippets[0]
src = snippet.read_text()

# Guard: the upstream markers this patch depends on must be present. If any is
# gone, wasm-bindgen-rayon was upgraded/changed — stop and make a human look.
for marker in (
    "new URL('./workerHelpers.js', import.meta.url)",
    "wasm_bindgen_worker_init",
    "wbg_rayon_start_worker",
    "export async function startWorkers",
):
    if marker not in src:
        sys.exit(
            f"ERROR (#2097 patch): upstream marker not found in {snippet}:\n"
            f"    {marker!r}\n"
            f"wasm-bindgen-rayon's generated code changed. Re-derive the "
            f"nested-worker patch (see this script and #2097) before shipping, "
            f"or the WASM thread pool will silently fall back to single-threaded."
        )

# Parent-side half: keeps `startWorkers`, drops the worker-side message handler
# (which now lives in the separate worker entry below), and spawns that entry by
# absolute served URL.
parent = '''\
/*
 * Copyright 2022 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Maple patch (#2097): parent-side half only. The worker-side message handler
// that upstream keeps here was moved to `/pkg/workerHelpers.worker.js` (written
// at the pkg root by scripts/sync-raw-wasm.sh) so the Angular/esbuild bundler
// can't fold the two roles together and mangle the self-spawn URL. Applied on
// every `pkg/` re-sync by src/web/scripts/sync-raw-wasm.sh.

function waitForMsgType(target, type) {
  return new Promise((resolve) => {
    target.addEventListener('message', function onMsg({ data }) {
      if (data?.type !== type) return;
      target.removeEventListener('message', onMsg);
      resolve(data);
    });
  });
}

// Note: this is never used, but necessary to prevent a bug in Firefox
// (https://bugzilla.mozilla.org/show_bug.cgi?id=1702191) where it collects
// Web Workers that have a shared WebAssembly memory with the main thread,
// but are not explicitly rooted via a `Worker` instance.
let _workers;

export async function startWorkers(module, memory, builder) {
  if (builder.numThreads() === 0) {
    throw new Error(`num_threads must be > 0.`);
  }

  const workerInit = {
    type: 'wasm_bindgen_worker_init',
    init: { module_or_path: module, memory },
    receiver: builder.receiver()
  };

  _workers = await Promise.all(
    Array.from({ length: builder.numThreads() }, async () => {
      // Spawn the worker-side entry by ABSOLUTE served URL. It cannot be a
      // relative `new URL(..., import.meta.url)`: this code is bundled into the
      // render-worker chunk, and esbuild neither rewrites nor re-emits a
      // `new Worker(new URL())` that sits inside a worker bundle, so a relative
      // URL resolves to the chunk's dir (server root) and 404s. `/pkg/...` is a
      // stable path served in dev (Angular assets) and prod (src/api static UI).
      const worker = new Worker(new URL('/pkg/workerHelpers.worker.js', import.meta.url), {
        type: 'module'
      });
      worker.postMessage(workerInit);
      await waitForMsgType(worker, 'wasm_bindgen_worker_ready');
      return worker;
    })
  );
  builder.build();
}
'''

# Worker-side half: loaded as a plain ES-module worker at runtime from the
# stable `/pkg/` path. Loads the sibling glue (`./raw_wasm.js`) at runtime and
# reuses the compiled module + shared memory passed via postMessage.
worker_side = '''\
// Maple patch (#2097) — rayon sub-worker entry.
//
// Lives at the pkg ROOT so it is copied to a stable, hash-free served path
// `/pkg/workerHelpers.worker.js` and loaded as a plain ES-module worker at
// runtime. wasm-bindgen-rayon's own self-spawn can't survive the
// Angular/esbuild bundler (it is inlined into the render-worker chunk and the
// nested `new Worker(new URL())` is left resolving to the server root, a 404).
// `startWorkers` (patched workerHelpers.js) spawns THIS file by absolute URL
// instead, and the glue is loaded here at runtime rather than bundle-time.
//
// The compiled WebAssembly.Module and shared memory arrive via postMessage, so
// `pkg.default(init)` reuses them — no second wasm fetch.
//
// This file and pkg/raw_wasm.js are published to `/pkg/` by the `assets` globs
// in angular.json, and re-generated on every `pkg/` re-sync by
// src/web/scripts/sync-raw-wasm.sh.

function waitForMsgType(target, type) {
  return new Promise((resolve) => {
    target.addEventListener('message', function onMsg({ data }) {
      if (data?.type !== type) return;
      target.removeEventListener('message', onMsg);
      resolve(data);
    });
  });
}

waitForMsgType(self, 'wasm_bindgen_worker_init').then(async ({ init, receiver }) => {
  // Sibling glue at /pkg/raw_wasm.js (served as a static asset). Explicit
  // filename so native ES-module resolution in the worker works without a
  // bundler resolving the package entry for us.
  const pkg = await import('./raw_wasm.js');
  await pkg.default(init);
  postMessage({ type: 'wasm_bindgen_worker_ready' });
  pkg.wbg_rayon_start_worker(receiver);
});
'''

snippet.write_text(parent)
(pkg / "workerHelpers.worker.js").write_text(worker_side)
print("Applied #2097 nested-worker patch (spawn /pkg/workerHelpers.worker.js).")
PYEOF
