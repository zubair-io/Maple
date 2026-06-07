// ObservabilityConfigCache — IndexedDB write-through layer for the SigNoz
// config pulled from `GET /api/observability/config`.
//
// Mirrors `SidecarIdbCache` (a hand-rolled IDB module, no extra dependency).
// A single record keyed `'current'` holds the last config the API returned.
// `ObservabilityService` reads it synchronously on startup so the OTel SDK can
// initialise from cache without waiting for the network, then refreshes in the
// background and writes the fresh config back through here.
//
// Kept small + injectable so tests can swap in the in-memory fake.

import { Injectable, InjectionToken, inject } from '@angular/core';
import type { ObservabilityConfigResponse } from './observability-config.model';
import { openDb, reqToPromise, txDone } from '../util/idb';

const IDB_DB_NAME = 'maple-observability';
const IDB_STORE = 'config';
const IDB_VERSION = 1;
/** Single-row store — the config is global to the client, not keyed by asset
 * or user. We always read/write the one `'current'` record. */
const RECORD_KEY = 'current';

/** Persisted record. `storedAt` powers the "last refreshed" line in Settings. */
export interface ObservabilityCacheRecord {
  key: string;
  config: ObservabilityConfigResponse;
  storedAt: number;
}

/**
 * Contract used by `ObservabilityService`. Implementations must not throw on a
 * missing record — return `null`. Errors are reserved for "the cache itself is
 * broken" (quota, schema mismatch); the service logs + bypasses on those.
 */
export interface ObservabilityConfigCache {
  get(): Promise<ObservabilityCacheRecord | null>;
  put(config: ObservabilityConfigResponse): Promise<void>;
  clear(): Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class ObservabilityConfigIdbCache implements ObservabilityConfigCache {
  async get(): Promise<ObservabilityCacheRecord | null> {
    const db = await this._open();
    const tx = db.transaction(IDB_STORE, 'readonly');
    const result = await reqToPromise(tx.objectStore(IDB_STORE).get(RECORD_KEY)).finally(() =>
      db.close(),
    );
    return (result as ObservabilityCacheRecord | undefined) ?? null;
  }

  async put(config: ObservabilityConfigResponse): Promise<void> {
    const db = await this._open();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const record: ObservabilityCacheRecord = {
      key: RECORD_KEY,
      config,
      storedAt: Date.now(),
    };
    tx.objectStore(IDB_STORE).put(record);
    await txDone(tx).finally(() => db.close());
  }

  async clear(): Promise<void> {
    const db = await this._open();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    await txDone(tx).finally(() => db.close());
  }

  private _open(): Promise<IDBDatabase> {
    return openDb(IDB_DB_NAME, IDB_VERSION, (db) => {
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'key' });
      }
    });
  }
}

/**
 * In-memory implementation. Exposed so tests (and SSR/non-IDB environments)
 * can provide an alternative without faking IndexedDB.
 */
export class InMemoryObservabilityConfigCache implements ObservabilityConfigCache {
  private record: ObservabilityCacheRecord | null = null;

  async get(): Promise<ObservabilityCacheRecord | null> {
    return this.record;
  }

  async put(config: ObservabilityConfigResponse): Promise<void> {
    this.record = { key: RECORD_KEY, config, storedAt: Date.now() };
  }

  async clear(): Promise<void> {
    this.record = null;
  }
}

/** DI token used by `ObservabilityService`. The factory goes through
 * `inject(ObservabilityConfigIdbCache)` so the class participates in DI and
 * tests can `useValue` the in-memory fake against the token. */
export const OBSERVABILITY_CONFIG_CACHE = new InjectionToken<ObservabilityConfigCache>(
  'OBSERVABILITY_CONFIG_CACHE',
  {
    providedIn: 'root',
    factory: () => inject(ObservabilityConfigIdbCache),
  },
);
