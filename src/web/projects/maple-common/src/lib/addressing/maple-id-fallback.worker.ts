/// <reference lib="webworker" />

// maple-id-fallback.worker.ts — dedicated worker for streaming fallback-form
// `maple_id` hashing (#1995).
//
// Deliberately a SEPARATE worker from `raw-pipeline.worker.ts` (the
// decode/live-render worker), not a new request type folded into it:
// `raw-pipeline.service.ts` enforces a single-in-flight-decode gate
// (`decodeChain`) because a RAW develop's f32 scratch buffers can blow past
// the wasm32 4 GiB heap cap if two decodes overlap — that gate exists to
// protect the performance-critical live-render path (CLAUDE.md's 16ms
// slider-tick budget). Folding unrelated fallback-id hashing (which can run
// during ordinary folder browsing, independent of whether an image is open
// for editing) into that same worker would contend with the decode gate for
// no benefit. This worker loads the SAME `pkg/raw_wasm` bundle — the browser
// caches the compiled WASM module across worker instances on the same
// origin, so the extra load is cheap — but only ever touches the lightweight
// streaming `FallbackIdHasher`: no rayon thread pool, no GPU session, no
// `initRawWasm()` (that helper's thread-pool dance is decode-specific
// overhead this worker doesn't need).
//
// Like `raw-pipeline.worker.ts`, this file is NOT re-exported from
// `public-api.ts` — it's reachable only via the runtime
// `new Worker(new URL('./maple-id-fallback.worker', import.meta.url))` call
// in `maple-id-fallback-hasher.service.ts`, which does not create a static
// import edge ng-packagr would try to resolve (see that service's module doc).

// Same gitignored, wasm-pack-generated path `raw-pipeline.worker.ts` already
// imports; only resolvable after the raw-wasm build+sync step, which
// fallow's audit job doesn't run.
// fallow-ignore-next-line unresolved-import
import init, { FallbackIdHasher, install_panic_hook } from '../raw-pipeline/pkg/raw_wasm';
import type {
  HashFallbackFinalizeRequest,
  HashFallbackRequest,
  HashFallbackResponse,
} from './maple-id-fallback.types';

let readyPromise: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = init().then(() => {
      // Surface Rust panics in DevTools instead of opaque WASM traps.
      try {
        install_panic_hook();
      } catch {
        // Older pkg without the export — non-fatal.
      }
    });
  }
  return readyPromise;
}

/** Live streaming-hasher state, keyed by the caller's per-file `id`. */
const hashers = new Map<number, FallbackIdHasher>();
/** Sticky error for an `id` whose hasher hit a `JsError` mid-stream — later
 * updates for the same `id` are ignored and `finalize` reports the error
 * instead of a bogus/partial hash. */
const failures = new Map<number, string>();

function post(msg: HashFallbackResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handleUpdate(req: Extract<HashFallbackRequest, { type: 'hash-fallback-update' }>) {
  if (failures.has(req.id)) return;
  try {
    // `ensureReady()` belongs inside this try, not before it: a rejected
    // `init()` (the WASM bundle failing to load/instantiate) must land in
    // the same "mark this id failed, let finalize report it" path as any
    // other update-time error — left outside the try, that rejection would
    // propagate out of this async function unhandled (this is only ever
    // called via `void handleUpdate(...)`, so nothing awaits it) and the
    // main thread's pending `hashFallback()` promise for this id would
    // never resolve OR reject.
    await ensureReady();
    let hasher = hashers.get(req.id);
    if (!hasher) {
      hasher = new FallbackIdHasher();
      hashers.set(req.id, hasher);
    }
    hasher.update(new Uint8Array(req.chunk));
  } catch (err) {
    failures.set(req.id, errorMessage(err));
  }
}

async function handleFinalize(req: HashFallbackFinalizeRequest): Promise<void> {
  try {
    // Same reasoning as `handleUpdate`: a rejected `ensureReady()` here must
    // not propagate unhandled — `finalize` is the terminal call for this
    // id, so unlike `handleUpdate` (which can defer reporting to a later
    // `finalize`), this catch must itself post the error back.
    await ensureReady();
  } catch (err) {
    hashers.get(req.id)?.free();
    hashers.delete(req.id);
    failures.delete(req.id);
    post({ id: req.id, type: 'hash-fallback-error', message: errorMessage(err) });
    return;
  }
  const failure = failures.get(req.id);
  const existingHasher = hashers.get(req.id);
  hashers.delete(req.id);
  failures.delete(req.id);
  if (failure) {
    // Free whatever hasher a prior successful `update` created for this id
    // before this failure — never construct a fresh one just to abandon it
    // unfreed (a WASM linear-memory leak; a zero-byte-file finalize with no
    // failure is the only case that needs the "no hasher yet" fallback,
    // handled in the branch below).
    existingHasher?.free();
    post({ id: req.id, type: 'hash-fallback-error', message: failure });
    return;
  }
  // A zero-byte file never gets an `update` call — finalize a fresh hasher
  // so `fallback(emptyBytes, 0)` is still reachable.
  const hasher = existingHasher ?? new FallbackIdHasher();
  try {
    const hex = hasher.finalize(req.filesize);
    post({ id: req.id, type: 'hash-fallback-success', hex });
  } catch (err) {
    post({ id: req.id, type: 'hash-fallback-error', message: errorMessage(err) });
  }
}

addEventListener('message', (event: MessageEvent<HashFallbackRequest>) => {
  const req = event.data;
  if (req.type === 'hash-fallback-update') {
    void handleUpdate(req);
    return;
  }
  void handleFinalize(req);
});
