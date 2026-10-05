import type { lensGestureStorage } from './lens-gesture-storage';

type GestureStorage = Awaited<ReturnType<typeof lensGestureStorage>>;

/** Keep both direct focus setters synchronous, before any render or read. */
export function coalesceGestureFocus(
  storage: GestureStorage,
  route: 'other' | 'roundtrip' | 'none',
) {
  storage.library.focusedAssetId.set(route === 'none' ? null : storage.ids[1]);
  if (route === 'roundtrip') storage.library.focusedAssetId.set(storage.ids[0]);
  const focused = storage.library.focusedAssetId();
  if (focused) storage.editor.bind(focused);
  return focused;
}

export async function disposeGestureStorage(
  storage: GestureStorage,
  failure: { error: unknown } | null,
) {
  try {
    await storage.dispose();
  } catch (cleanupError) {
    throw failure === null
      ? cleanupError
      : new AggregateError([failure.error, cleanupError], 'Gesture workflow and cleanup failed');
  }
}
