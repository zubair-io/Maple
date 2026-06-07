// Minimal, typed IndexedDB helper.
//
// Three primitives that eliminate the `new Promise((resolve, reject) => …)` +
// event-handler boilerplate repeated across every IDB-backed cache module:
//
//   openDb(name, version, upgrade)  — open (or upgrade) a database
//   reqToPromise(req)               — wrap a single IDBRequest as a Promise
//   txDone(tx)                      — resolve when a transaction commits,
//                                     reject on error or abort
//
// Per `best-practices.md` ("Don't reinvent the wheel" → IndexedDB via a
// minimal wrapper, not raw IDBRequest) this stays an in-house helper rather
// than pulling in `idb`/Dexie — the surface we need is tiny and the
// three-function API matches exactly what the four cache modules require.
//
// Behavior contract (preserved from the inline hand-rolled code):
//   - `openDb` calls `db.close()` after every transaction in callers — that
//     pattern is preserved; the helper does NOT hold a connection open.
//   - Errors propagate as the native DOMException stored in
//     `IDBRequest.error` / `IDBTransaction.error`.

/** Called during `onupgradeneeded`. Perform all `createObjectStore` /
 *  `deleteObjectStore` work here. */
export type IdbUpgradeFn = (db: IDBDatabase, event: IDBVersionChangeEvent) => void;

/**
 * Open (or upgrade) an IndexedDB database.
 *
 * Resolves with the open `IDBDatabase`. The caller is responsible for
 * calling `db.close()` after each transaction to avoid leaving the
 * connection open (matching the established pattern in the cache modules).
 */
export function openDb(name: string, version: number, upgrade: IdbUpgradeFn): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (event) => upgrade(req.result, event);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Wrap a single `IDBRequest` as a Promise that resolves with `req.result`.
 *
 * Use this for `get` / `getAll` requests where you want the result value
 * without waiting for the full transaction to commit.
 */
export function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Resolve when the transaction commits; reject on error or abort.
 *
 * Use this for write transactions (`readwrite`) where you need the
 * commit confirmation before proceeding (e.g. `put`, `delete`, `clear`).
 */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}
