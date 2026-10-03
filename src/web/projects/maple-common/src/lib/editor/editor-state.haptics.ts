// Browser haptic feedback for editor actions.
export type HapticEvent =
  | 'zero-cross' // .light  / vibrate(8)
  | 'extreme' //   .medium / vibrate(12)
  | 'reset' //     .selection / vibrate(4)
  | 'switch'; //   .selection / vibrate(4)

const HAPTIC_DURATION_MS: Record<HapticEvent, number> = {
  'zero-cross': 8,
  extreme: 12,
  reset: 4,
  switch: 4,
};

export function triggerHaptic(event: HapticEvent): void {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  if (nav && typeof nav.vibrate === 'function') {
    nav.vibrate(HAPTIC_DURATION_MS[event]);
  }
}
