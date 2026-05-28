// motion.ts — responsive-program S0a (epic #577, ticket #581).
//
// Web mirror of Apple's MapleTokens.Motion enum (DesignTokens.swift).
// Duration + easing tokens for shell transitions, sheet present/dismiss,
// group/tool swap, chrome hide, filter fade. Values must stay in sync
// with the Swift side and with motion.scss.

export const MapleMotion = {
  /** Drawer open/close (sidebar collapse on tablet/desktop). */
  drawer: {
    ms: 240,
    ease: 'cubic-bezier(0.22, 1, 0.36, 1)' as const,
  },
  /** Push transition (iOS-system feel). */
  push: {
    ms: 320,
    ease: 'cubic-bezier(0.32, 0.72, 0, 1)' as const,
  },
  /** Sheet present. */
  sheetPresent: {
    ms: 320,
    ease: 'cubic-bezier(0.32, 0.72, 0, 1)' as const,
  },
  /** Sheet dismiss. */
  sheetDismiss: {
    ms: 280,
    ease: 'cubic-bezier(0.32, 0.72, 0, 1)' as const,
  },
  /** Editor group/tool tab swap. */
  groupSwap: {
    ms: 120,
    ease: 'ease-in-out' as const,
  },
  /** Loupe chrome auto-hide. */
  chromeHide: {
    ms: 180,
    ease: 'ease-out' as const,
  },
  /** Library filter chip change cross-fade. */
  filterFade: {
    ms: 120,
    ease: 'linear' as const,
  },
} as const;

export type MapleMotionKey = keyof typeof MapleMotion;
