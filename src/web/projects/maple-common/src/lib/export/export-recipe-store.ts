/** Saved recipes and the active browser/server queue survive reload in one IndexedDB. */
import { parseExportRecipe, type ExportRecipe } from '../generated/export-recipe.generated';
import type { BatchSummary } from '../editor/copy-paste/batch-sync';

export interface RecipeTarget {
  id: string;
  filename: string;
  path: string | null;
  xmp: string;
  filmLook: string;
  capturedAt: string | null;
  index: number;
  sourceHandle?: FileSystemFileHandle;
}
export interface RecipeEntry {
  id: string;
  status: 'pending' | 'rendering' | 'delivering' | 'writing' | 'applied' | 'skipped' | 'failed';
  reason?: string;
  filename?: string;
  beforeHash?: string | null;
  afterHash?: string;
}
export interface RecipeQueueRecord {
  id: string;
  recipe: ExportRecipe;
  targets: RecipeTarget[];
  entries: RecipeEntry[];
  serverJobId: string | null;
  cancelled: boolean;
  directoryHandle?: FileSystemDirectoryHandle;
}

async function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('maple-export-recipes', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('recipes', { keyPath: 'name' });
      request.result.createObjectStore('queue');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(
  store: string,
  mode: IDBTransactionMode,
  request: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await db();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(store, mode);
      const operation = request(tx.objectStore(store));
      tx.oncomplete = () => resolve(operation.result);
      tx.onabort = () => reject(tx.error ?? operation.error);
      tx.onerror = () => reject(tx.error ?? operation.error);
    });
  } finally {
    database.close();
  }
}
export async function savedRecipes(): Promise<ExportRecipe[]> {
  const values: unknown[] = await transaction('recipes', 'readonly', (store) => store.getAll());
  return values.map(parseExportRecipe);
}
export async function saveRecipe(value: unknown): Promise<void> {
  const recipe = parseExportRecipe(value);
  if (!recipe.name.trim()) throw new Error('Give the recipe a name before saving');
  await transaction('recipes', 'readwrite', (store) => store.put(recipe));
}
export async function deleteRecipe(name: string): Promise<void> {
  await transaction('recipes', 'readwrite', (store) => store.delete(name));
}
export async function readExportQueue(): Promise<RecipeQueueRecord | null> {
  const value: RecipeQueueRecord | undefined = await transaction('queue', 'readonly', (store) =>
    store.get('active'),
  );
  if (!value) return null;
  parseExportRecipe(value.recipe);
  return value;
}
export async function saveExportQueue(value: RecipeQueueRecord): Promise<void> {
  await transaction('queue', 'readwrite', (store) => store.put(value, 'active'));
}
/** A browser recipe stores an opaque handle key, never a guessed operating-system path. */
export async function saveRecipeDirectory(handle: FileSystemDirectoryHandle): Promise<string> {
  const key = `browser-folder:${crypto.randomUUID()}`;
  await transaction('queue', 'readwrite', (store) => store.put(handle, key));
  return key;
}
export async function readRecipeDirectory(key: string): Promise<FileSystemDirectoryHandle | null> {
  return (await transaction('queue', 'readonly', (store) => store.get(key))) ?? null;
}
export function recipeSummary(record: RecipeQueueRecord): BatchSummary<string> {
  return {
    applied: record.entries.filter((entry) => entry.status === 'applied').map((entry) => entry.id),
    failed: record.entries
      .filter((entry) => entry.status === 'failed')
      .map((entry) => ({ id: entry.id, reason: entry.reason ?? 'Export failed' })),
    cancelled: record.cancelled,
  };
}
/** No automatic replay after an unacknowledged browser download: its outcome is unknowable. */
export function recoverBrowserQueue(record: RecipeQueueRecord): RecipeQueueRecord {
  return {
    ...record,
    entries: record.entries.map((entry) => {
      if (entry.status === 'rendering') return { id: entry.id, status: 'pending' };
      if (entry.status === 'delivering')
        return {
          ...entry,
          status: 'failed',
          reason:
            'Download outcome unknown after interruption. Check your downloads before retrying.',
        };
      return entry;
    }),
  };
}
