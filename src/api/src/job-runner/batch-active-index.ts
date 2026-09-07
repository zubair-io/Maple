import type { Collection } from 'mongodb';

const readiness = new Map<string, Promise<void>>();

/** Fail closed until the cross-client active-library fence is available. */
export function ensureBatchActiveLibraryIndex(
  collection: Pick<Collection, 'namespace' | 'createIndex'>,
): Promise<void> {
  const existing = readiness.get(collection.namespace);
  if (existing) return existing;
  const pending = collection
    .createIndex(
      { batch_scopes: 1 },
      {
        name: 'batch_active_library',
        unique: true,
        partialFilterExpression: {
          kind: 'batch_adjustment_sync',
          status: { $in: ['queued', 'running'] },
          batch_scopes: { $exists: true },
        },
      },
    )
    .then(() => undefined)
    .catch((error) => {
      readiness.delete(collection.namespace);
      throw error;
    });
  readiness.set(collection.namespace, pending);
  return pending;
}
