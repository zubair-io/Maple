// preview-shell-keyboard.ts — pure key→action mapper for PreviewShellComponent
// (#Web Preview Surface, Task 5). Kept side-effect-free so it's trivially
// unit-testable; the component wires the returned action into
// LibraryStateService calls and router navigation.

export type PreviewKeyAction =
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'rating'; value: number }
  | { kind: 'flag'; flag: 'pick' | 'reject' | 'unflagged' };

const RATING_KEYS = new Set(['0', '1', '2', '3', '4', '5']);

/**
 * Maps a `KeyboardEvent.key` to a preview navigation/rating/flag action, or
 * `null` if the key isn't handled by the preview surface.
 */
export function previewKeyAction(key: string): PreviewKeyAction | null {
  if (key === 'ArrowRight') return { kind: 'next' };
  if (key === 'ArrowLeft') return { kind: 'prev' };
  if (RATING_KEYS.has(key)) return { kind: 'rating', value: Number(key) };
  if (key === 'p' || key === 'P') return { kind: 'flag', flag: 'pick' };
  if (key === 'x' || key === 'X') return { kind: 'flag', flag: 'reject' };
  if (key === 'u' || key === 'U') return { kind: 'flag', flag: 'unflagged' };
  return null;
}
