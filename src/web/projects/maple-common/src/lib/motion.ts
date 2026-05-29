// motion.ts — responsive-program S0a (epic #577, ticket #581).
//
// Web mirror of Apple's MapleTokens.Motion enum (DesignTokens.swift).
// Duration + easing tokens for shell transitions, sheet present/dismiss,
// group/tool swap, chrome hide, filter fade.
//
// Ticket #606: the canonical duration + easing pairs live in
// `raw_core::ui_tokens::MOTION_TOKENS` and are emitted to
// `./generated/ui-tokens.ts` by `tools/codegen.sh`. This file preserves the
// stable `MapleMotion` API surface — every consumer keeps importing from
// `maple-common` and gets the same shape as before.

import { MAPLE_UI_MOTION } from './generated/ui-tokens';

export const MapleMotion = {
  /** Drawer open/close (sidebar collapse on tablet/desktop). */
  drawer: MAPLE_UI_MOTION.drawer,
  /** Push transition (iOS-system feel). */
  push: MAPLE_UI_MOTION.push,
  /** Sheet present. */
  sheetPresent: MAPLE_UI_MOTION.sheetPresent,
  /** Sheet dismiss. */
  sheetDismiss: MAPLE_UI_MOTION.sheetDismiss,
  /** Editor group/tool tab swap. */
  groupSwap: MAPLE_UI_MOTION.groupSwap,
  /** Editor chrome auto-hide. */
  chromeHide: MAPLE_UI_MOTION.chromeHide,
  /** Library filter chip change cross-fade. */
  filterFade: MAPLE_UI_MOTION.filterFade,
} as const;

export type MapleMotionKey = keyof typeof MapleMotion;
