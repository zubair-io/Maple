/**
 * The files a PhotoKit backup stores beside an original, each in its own
 * `assets` column: the Apple-rendered edit and a Live Photo's `.mov` twin
 * (#5243). Anything that moves, backs up or erases an asset carries every slot.
 */
export const APPLE_COMPANION_SLOTS = ['apple_rendered_path', 'apple_live_video_path'] as const;

export type AppleCompanionSlot = (typeof APPLE_COMPANION_SLOTS)[number];

export type AppleCompanionPaths = Record<AppleCompanionSlot, string | null>;

type MaybeCompanions = Partial<Record<AppleCompanionSlot, string | null | undefined>>;

/** The recorded companion rel paths, in slot order. */
export function appleCompanionPaths(row: MaybeCompanions): string[] {
  return APPLE_COMPANION_SLOTS.flatMap((slot) => {
    const recorded = row[slot];
    return recorded ? [recorded] : [];
  });
}

/** The recorded slots as optional fields, for rows that omit an empty one. */
export function presentAppleCompanions(
  row: MaybeCompanions,
): Partial<Record<AppleCompanionSlot, string>> {
  return Object.fromEntries(
    APPLE_COMPANION_SLOTS.flatMap((slot) => {
      const recorded = row[slot];
      return recorded ? [[slot, recorded]] : [];
    }),
  );
}
