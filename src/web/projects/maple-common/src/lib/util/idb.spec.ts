// Unit tests for the shared IDB helper (`util/idb.ts`).
//
// `fake-indexeddb` is not in the project's dev-dependencies and jsdom does not
// ship an IDBFactory implementation, so these tests validate the promise-wrapping
// logic of `reqToPromise` and `txDone` using minimal hand-rolled stubs that fire
// the same event-handler slots the helpers attach to.  The full open→read/write
// cycle is covered by CI's Angular `ng test` run which uses a real browser.
//
// Run:
//   bun x vitest run src/web/projects/maple-common/src/lib/util/idb.spec.ts \
//     --globals --environment jsdom --no-coverage

import { describe, it, expect } from 'vitest';
import { reqToPromise, txDone } from './idb';

// ── Minimal IDB stubs ─────────────────────────────────────────────────────────

/** Minimal stub for IDBRequest that lets callers fire onsuccess / onerror. */
function makeRequest<T>(result: T | null, error: DOMException | null = null): IDBRequest<T> {
  const req = {
    result,
    error,
    onsuccess: null as ((ev: Event) => void) | null,
    onerror: null as ((ev: Event) => void) | null,
  } as unknown as IDBRequest<T>;
  return req;
}

function fireSuccess(req: IDBRequest): void {
  if (typeof req.onsuccess === 'function') {
    req.onsuccess({} as Event);
  }
}

function fireError(req: IDBRequest): void {
  if (typeof req.onerror === 'function') {
    req.onerror({} as Event);
  }
}

/** Minimal stub for IDBTransaction. */
function makeTx(error: DOMException | null = null): IDBTransaction {
  const tx = {
    error,
    oncomplete: null as ((ev: Event) => void) | null,
    onerror: null as ((ev: Event) => void) | null,
    onabort: null as ((ev: Event) => void) | null,
  } as unknown as IDBTransaction;
  return tx;
}

function fireComplete(tx: IDBTransaction): void {
  if (typeof tx.oncomplete === 'function') {
    tx.oncomplete({} as Event);
  }
}

function fireTxError(tx: IDBTransaction): void {
  if (typeof tx.onerror === 'function') {
    tx.onerror({} as Event);
  }
}

function fireTxAbort(tx: IDBTransaction): void {
  if (typeof tx.onabort === 'function') {
    tx.onabort({} as Event);
  }
}

// ── reqToPromise ──────────────────────────────────────────────────────────────

describe('reqToPromise', () => {
  it('resolves with req.result when onsuccess fires', async () => {
    const req = makeRequest<string>('hello');
    const p = reqToPromise(req);
    fireSuccess(req);
    await expect(p).resolves.toBe('hello');
  });

  it('resolves with null result (missing key) when onsuccess fires', async () => {
    const req = makeRequest<string | null>(null);
    const p = reqToPromise(req);
    fireSuccess(req);
    await expect(p).resolves.toBeNull();
  });

  it('rejects with req.error when onerror fires', async () => {
    const err = new DOMException('disk full', 'QuotaExceededError');
    const req = makeRequest<string>(null, err);
    const p = reqToPromise(req);
    fireError(req);
    await expect(p).rejects.toBe(err);
  });
});

// ── txDone ────────────────────────────────────────────────────────────────────

describe('txDone', () => {
  it('resolves (undefined) when oncomplete fires', async () => {
    const tx = makeTx();
    const p = txDone(tx);
    fireComplete(tx);
    await expect(p).resolves.toBeUndefined();
  });

  it('rejects with tx.error when onerror fires', async () => {
    const err = new DOMException('constraint', 'ConstraintError');
    const tx = makeTx(err);
    const p = txDone(tx);
    fireTxError(tx);
    await expect(p).rejects.toBe(err);
  });

  it('rejects with an AbortError when onabort fires and tx.error is null', async () => {
    const tx = makeTx(null);
    const p = txDone(tx);
    fireTxAbort(tx);
    const caught = await p.catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
  });

  it('rejects with tx.error when onabort fires and tx.error is set', async () => {
    const err = new DOMException('conflict', 'AbortError');
    const tx = makeTx(err);
    const p = txDone(tx);
    fireTxAbort(tx);
    await expect(p).rejects.toBe(err);
  });
});
