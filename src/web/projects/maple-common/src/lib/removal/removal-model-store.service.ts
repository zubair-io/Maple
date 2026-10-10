// Explicit local model installation for the #3941 experiment. No automatic
// distribution or release qualification is implied by installing a graph.
import { Injectable, signal } from '@angular/core';
import {
  EXPERIMENTAL_REMOVAL_MODELS,
  type RemovalModelId,
} from '../generated/removal-models.generated';
import { openDb, reqToPromise, txDone } from '../util/idb';

@Injectable({ providedIn: 'root' })
export class RemovalModelStore {
  readonly models = signal<ReadonlyMap<RemovalModelId, Blob>>(new Map());
  readonly pins = EXPERIMENTAL_REMOVAL_MODELS;
  readonly error = signal('');
  private readonly ready = this.restore().catch((error) =>
    this.error.set(error instanceof Error ? error.message : String(error)),
  );

  async installed(): Promise<ReadonlyMap<RemovalModelId, Blob>> {
    await this.ready;
    if (this.error()) throw new Error(this.error());
    return this.models();
  }
  async install(file: File): Promise<void> {
    await this.ready;
    const pin = this.pins.find((value) => value.file === file.name);
    if (!pin || file.size !== pin.size)
      throw new Error('Choose one of the listed Maple model files.');
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
      (value) => value.toString(16).padStart(2, '0'),
    ).join('');
    if (hash !== pin.sha256) throw new Error('Model checksum does not match the pinned graph.');
    const db = await this.db();
    try {
      const tx = db.transaction('models', 'readwrite');
      tx.objectStore('models').put(file, pin.id);
      await txDone(tx);
      this.models.update((models) => new Map([...models, [pin.id, file]]));
    } finally {
      db.close();
    }
  }
  async uninstall(id: RemovalModelId): Promise<void> {
    await this.ready;
    const db = await this.db();
    try {
      const tx = db.transaction('models', 'readwrite');
      tx.objectStore('models').delete(id);
      await txDone(tx);
      this.models.update((models) => new Map([...models].filter(([key]) => key !== id)));
    } finally {
      db.close();
    }
  }
  private async restore(): Promise<void> {
    const db = await this.db();
    try {
      const store = db.transaction('models', 'readonly').objectStore('models');
      const entries = await Promise.all(
        this.pins.map(async (pin) => {
          const file: unknown = await reqToPromise(store.get(pin.id));
          return file instanceof Blob && file.size === pin.size ? ([pin.id, file] as const) : null;
        }),
      );
      this.models.set(new Map(entries.filter((entry) => entry !== null)));
    } finally {
      db.close();
    }
  }
  private db(): Promise<IDBDatabase> {
    return openDb('maple-removal-models', 1, (db) => db.createObjectStore('models'));
  }
}
