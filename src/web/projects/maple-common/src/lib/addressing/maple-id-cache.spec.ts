// maple-id-cache.spec.ts — proves the IndexedDB-backed cache round-trips a
// computed `maple_id` and correctly detects staleness on a size/mtime
// mismatch (a file replaced at the same path must not silently inherit the
// old id).
//
// jsdom ships no IDBFactory and `fake-indexeddb` is not a project
// dependency (see `idb.spec.ts`'s module doc — this repo's established
// precedent for IDB-backed specs is to stub the platform surface directly).
// `idb.spec.ts` already proves `reqToPromise`/`txDone` correctly wrap
// IDBRequest/IDBTransaction event semantics in isolation; this spec goes one
// level up and provides a minimal in-memory `indexedDB` global (open /
// objectStore.get / objectStore.put / transaction completion) so
// `maple-id-cache.ts`'s OWN logic — key construction, the size/mtime
// staleness check — is exercised through a real `openDb` -> transaction ->
// get/put round trip, not just asserted against hand-mocked return values.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCachedMapleId, putCachedMapleId } from './maple-id-cache';

// ── Minimal in-memory IndexedDB fake ────────────────────────────────────────

interface FakeStore {
  keyPath: string;
  data: Map<IDBValidKey, unknown>;
}

interface FakeDb {
  name: string;
  stores: Map<string, FakeStore>;
}

const registry = new Map<string, FakeDb>();

class FakeRequest<T> {
  result: T | undefined;
  error: DOMException | null = null;
  onsuccess: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
}

class FakeOpenRequest extends FakeRequest<FakeDbHandle> {
  onupgradeneeded: ((ev: IDBVersionChangeEvent) => void) | null = null;
}

class FakeObjectStore {
  constructor(
    private readonly store: FakeStore,
    private readonly onOpStart: () => void,
    private readonly onOpEnd: () => void,
  ) {}

  get(key: IDBValidKey): IDBRequest {
    this.onOpStart();
    const req = new FakeRequest<unknown>();
    queueMicrotask(() => {
      req.result = this.store.data.get(key);
      this.onOpEnd();
      req.onsuccess?.({} as Event);
    });
    return req as unknown as IDBRequest;
  }

  put(value: Record<string, unknown>): IDBRequest {
    this.onOpStart();
    const req = new FakeRequest<IDBValidKey>();
    const key = value[this.store.keyPath] as IDBValidKey;
    queueMicrotask(() => {
      this.store.data.set(key, { ...value });
      req.result = key;
      this.onOpEnd();
      req.onsuccess?.({} as Event);
    });
    return req as unknown as IDBRequest;
  }
}

class FakeTransaction {
  oncomplete: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onabort: ((ev: Event) => void) | null = null;
  private pendingOps = 0;

  constructor(private readonly db: FakeDb) {
    this.pollForCompletion();
  }

  objectStore(name: string): FakeObjectStore {
    const store = this.db.stores.get(name);
    if (!store) throw new Error(`FakeTransaction: no such store "${name}"`);
    return new FakeObjectStore(
      store,
      () => this.pendingOps++,
      () => this.pendingOps--,
    );
  }

  /** Repeatedly re-checks (via microtask hops) whether every op issued
   * against this transaction has completed. Correct for this fake's actual
   * call pattern (at most one `get`/`put` per transaction, issued
   * synchronously right after the transaction is created) — see the
   * module doc for the ordering argument. */
  private pollForCompletion(): void {
    queueMicrotask(() => {
      if (this.pendingOps > 0) {
        this.pollForCompletion();
        return;
      }
      this.oncomplete?.({} as Event);
    });
  }
}

interface FakeDbHandle {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options: { keyPath: string }): void;
  transaction(name: string, _mode: IDBTransactionMode): FakeTransaction;
  close(): void;
}

function makeDbHandle(db: FakeDb): FakeDbHandle {
  return {
    objectStoreNames: { contains: (name) => db.stores.has(name) },
    createObjectStore: (name, options) => {
      db.stores.set(name, { keyPath: options.keyPath, data: new Map() });
    },
    transaction: (name) => new FakeTransaction(db),
    close: () => {
      /* no-op — this fake keeps data in `registry` across opens/closes,
       * matching real IndexedDB persistence. */
    },
  };
}

function installFakeIndexedDb(): void {
  const fakeIndexedDb = {
    open(name: string, _version: number): FakeOpenRequest {
      const req = new FakeOpenRequest();
      queueMicrotask(() => {
        let db = registry.get(name);
        const isNew = !db;
        if (!db) {
          db = { name, stores: new Map() };
          registry.set(name, db);
        }
        const handle = makeDbHandle(db);
        req.result = handle;
        if (isNew) {
          req.onupgradeneeded?.({ target: req } as unknown as IDBVersionChangeEvent);
        }
        req.onsuccess?.({} as Event);
      });
      return req;
    },
  };
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDb;
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  registry.clear();
  installFakeIndexedDb();
});

afterEach(() => {
  registry.clear();
});

describe('MapleIdCache', () => {
  it('returns null on a cache miss', async () => {
    const result = await getCachedMapleId('lib:2026/France/IMG_0001.dng', 1024, 1_700_000_000_000);
    expect(result).toBeNull();
  });

  it('round-trips a cached id for matching size/mtime', async () => {
    const key = 'lib:2026/France/IMG_0001.dng';
    await putCachedMapleId(key, 1024, 1_700_000_000_000, '01aabbccddeeff00112233445566778');
    const result = await getCachedMapleId(key, 1024, 1_700_000_000_000);
    expect(result).toBe('01aabbccddeeff00112233445566778');
  });

  it('treats a size mismatch as stale and returns null', async () => {
    const key = 'lib:2026/France/IMG_0001.dng';
    await putCachedMapleId(key, 1024, 1_700_000_000_000, '01aabbccddeeff00112233445566778');
    // Same mtime, DIFFERENT size — file replaced at this path.
    const result = await getCachedMapleId(key, 2048, 1_700_000_000_000);
    expect(result).toBeNull();
  });

  it('treats an mtime mismatch as stale and returns null', async () => {
    const key = 'lib:2026/France/IMG_0001.dng';
    await putCachedMapleId(key, 1024, 1_700_000_000_000, '01aabbccddeeff00112233445566778');
    // Same size, DIFFERENT mtime — file replaced at this path with
    // coincidentally identical size.
    const result = await getCachedMapleId(key, 1024, 1_700_000_000_001);
    expect(result).toBeNull();
  });

  it('overwrites a stale entry when re-cached with new size/mtime/id', async () => {
    const key = 'lib:2026/France/IMG_0001.dng';
    await putCachedMapleId(key, 1024, 1_700_000_000_000, '01aabbccddeeff00112233445566778');
    await putCachedMapleId(key, 2048, 1_700_000_000_999, '02ffeeddccbbaa99887766554433221');
    // Old (size, mtime) no longer matches.
    expect(await getCachedMapleId(key, 1024, 1_700_000_000_000)).toBeNull();
    // New (size, mtime) matches the new id.
    expect(await getCachedMapleId(key, 2048, 1_700_000_000_999)).toBe(
      '02ffeeddccbbaa99887766554433221',
    );
  });

  it('keeps distinct keys independent', async () => {
    await putCachedMapleId('lib:a.dng', 100, 1, '01111111111111111111111111111111'.slice(0, 32));
    await putCachedMapleId('lib:b.dng', 200, 2, '02222222222222222222222222222222'.slice(0, 32));
    expect(await getCachedMapleId('lib:a.dng', 100, 1)).toBe(
      '01111111111111111111111111111111'.slice(0, 32),
    );
    expect(await getCachedMapleId('lib:b.dng', 200, 2)).toBe(
      '02222222222222222222222222222222'.slice(0, 32),
    );
  });
});
