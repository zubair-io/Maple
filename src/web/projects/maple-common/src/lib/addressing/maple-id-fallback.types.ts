// Message protocol between `MapleIdFallbackHasherService` (main thread) and
// `maple-id-fallback.worker.ts` (#1995).
//
// Deliberately a plain types-only module with NO import of `pkg/raw_wasm` (or
// anything that transitively imports it): this file IS re-exported from
// `public-api.ts` / consumed by the ng-packagr-built `maple-common` library
// (the service needs these shapes), and ng-packagr cannot resolve the
// wasm-pack output module (see `raw-wasm-init.ts`'s module doc — that's why
// it, and the worker file below, are NOT re-exported from `public-api.ts`).
// Mirrors the existing split in `raw-pipeline.types.ts` (plain types, safe
// for ng-packagr) vs. `raw-pipeline.worker.ts` (imports `pkg/raw_wasm`,
// compiled only via the app builder's `webWorkerTsConfig`, never ng-packagr).
//
// Protocol: the caller mints one `id` per file-hash operation (NOT per
// message) and reuses it across every `hash-fallback-update` for that file's
// chunks plus the terminal `hash-fallback-finalize`. Updates are fire-and-
// forget — the worker's single message queue processes them strictly in
// the order they were posted, so the caller only needs to await the
// `finalize` response (which the worker only emits after every prior update
// for that `id` has been applied).

/** One chunk of a file's bytes, in file order. `chunk` is a transferable
 * ArrayBuffer — the caller does not reuse it after posting. */
export interface HashFallbackUpdateRequest {
  id: number;
  type: 'hash-fallback-update';
  chunk: ArrayBuffer;
}

/** Finish the streaming hash for `id` and request the fallback-form hex.
 * `filesize` is the file's true byte length (matches
 * `raw_core::FallbackIdHasher::finalize`'s contract — see raw-wasm/src/id.rs). */
export interface HashFallbackFinalizeRequest {
  id: number;
  type: 'hash-fallback-finalize';
  filesize: bigint;
}

export type HashFallbackRequest = HashFallbackUpdateRequest | HashFallbackFinalizeRequest;

/** 32-char lowercase hex fallback-form `maple_id` (same shape as
 * `MapleId.hex` from `maple-id.ts` — parseable via `fromHex()`). */
export interface HashFallbackSuccess {
  id: number;
  type: 'hash-fallback-success';
  hex: string;
}

export interface HashFallbackError {
  id: number;
  type: 'hash-fallback-error';
  message: string;
}

export type HashFallbackResponse = HashFallbackSuccess | HashFallbackError;
