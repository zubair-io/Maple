// Canonical store shape — slice 1 of N (Refs #193).
//
// Every `*.store.ts` under `src/lib/state/` is expected to implement this
// interface. The shape exists so that consumers (components, view-models,
// other stores) can speak to any store the same way: read `data()`, branch on
// `status()`, and call `invalidate()` to force a re-fetch.
//
// The shape is deliberately small. Specific stores extend it with
// entity-specific mutators (e.g. `SidecarStore.write(id, doc)`) — those don't
// belong on the base interface because the consumer-side contract is just
// "read + invalidate".
//
// Design notes for future implementers:
//
//   - `data` is `Signal<T | undefined>`. `undefined` means "no value yet". Use
//     `hasData()` (or `data() !== undefined`) before treating the value as
//     real. Stores backed by `httpResource` can wrap the resource's `value`
//     directly; stores backed by a different fetch strategy expose the same
//     signal shape.
//
//   - `loading` vs `refreshing` is the load-bearing distinction from the
//     brief. `loading` is "first fetch, no data to show". `refreshing` is
//     "we already have a value, but we're fetching a fresh one underneath" —
//     the consumer keeps showing the stale value and optionally renders a
//     subtle progress indicator. Derive as:
//         loading()     = isLoading && data === undefined
//         refreshing()  = isLoading && data !== undefined
//
//   - `error` is the last `Error` from the loader. Stores reset it to `null`
//     on the next successful resolution. Consumers render this directly.
//
//   - `status` is the discriminated union. Use it as the single source of
//     truth in templates: `@switch (store.status())`.
//
//   - `invalidate()` is the canonical re-fetch entry point. Mutators (rating
//     toggles, etc.) generally don't call `invalidate()` — they apply an
//     optimistic patch via the store's own writer and let the race guard
//     handle the eventual consistency.

import type { Signal } from '@angular/core';

/**
 * Discriminated union of store states. Maps onto Angular's `ResourceStatus`
 * for stores backed by `httpResource`, but the names are normalised so
 * non-resource-backed stores (e.g. ones built on `LiveQuery` over IDB) can
 * implement the same surface.
 *
 * - `idle`       — the store has never been asked to fetch (e.g. the input
 *                  signal is `undefined`).
 * - `loading`    — first-fetch in progress, no value yet. `data()` is
 *                  `undefined`.
 * - `loaded`     — a value is available. `data()` is defined.
 * - `refreshing` — a re-fetch is in progress and `data()` still holds the
 *                  previous value.
 * - `not-found`  — a fetch completed but the upstream returned no value
 *                  (e.g. a 404 normalised to "no sidecar yet"). `data()` is
 *                  `undefined`, `error()` is `null`. Distinct from `idle`
 *                  because we actually attempted a fetch.
 * - `error`      — the last fetch failed. `error()` is non-null. `data()`
 *                  holds whatever the previous successful value was (which
 *                  may be `undefined`).
 */
export type StoreStatus =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'refreshing'
  | 'not-found'
  | 'error';

/**
 * Canonical store contract. All `*.store.ts` files under `state/` implement
 * this. Entity-specific mutators (writers, optimistic patches) live on the
 * concrete class, not on this interface — consumers that only need to read
 * + react to status changes program against `Store<T>`.
 */
export interface Store<T> {
  /**
   * Current value, or `undefined` if no value has been loaded yet.
   *
   * Stays defined across `refreshing` transitions: when a re-fetch is in
   * flight, callers continue to see the previous value until the new one
   * resolves. This is what lets the UI stay populated without flashing.
   */
  readonly data: Signal<T | undefined>;

  /**
   * `true` while a first-fetch (no prior data) is in flight. Flips back to
   * `false` once the fetch resolves, regardless of outcome.
   *
   * UI rule of thumb: render a skeleton when `loading()`, render the value
   * when `!loading()`.
   */
  readonly loading: Signal<boolean>;

  /**
   * `true` while a re-fetch is in flight AND the store already has prior
   * data to show. Use this to render a subtle "updating…" affordance
   * without hiding the existing content.
   */
  readonly refreshing: Signal<boolean>;

  /**
   * The last error from the loader, or `null` if the last attempt succeeded
   * (or no attempt has been made yet).
   */
  readonly error: Signal<Error | null>;

  /**
   * Discriminated status. Prefer this over manual combinations of `loading`,
   * `refreshing`, `error`, and `data` — it's harder to get wrong in
   * templates.
   */
  readonly status: Signal<StoreStatus>;

  /**
   * Force the store to re-fetch from the upstream source. Bypasses any
   * "we already have data" short-circuits but still respects in-flight
   * deduplication.
   *
   * Mutators generally should NOT call `invalidate()` — they should apply
   * an optimistic patch and let the race guard reconcile. `invalidate()` is
   * the right call after a pessimistic mutation (delete, rescan) or in
   * response to an external signal (push notification, focus event).
   */
  invalidate(): void;
}
