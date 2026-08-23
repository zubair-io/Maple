// TypeScript mirror of tokens.scss — for use in component logic (not styles).
//
// Ticket #606: the color hex strings live in `raw_core::ui_tokens` and are
// emitted to `./generated/ui-tokens.ts` by `tools/codegen.sh`. This file
// stays as the public `MapleTokens` entry point so call sites and the
// `public-api.ts` export surface don't change.

import { MAPLE_UI_COLORS } from './generated/ui-tokens';

// Raw generated token tables, re-exported for consumers that iterate the
// full scale with keys (e.g. the hosted /maple-ui token gallery, #3000).
// Most call sites should keep using the curated `MapleTokens`/`MapleMotion`
// surfaces below and in motion.ts.
export {
  MAPLE_UI_COLORS,
  MAPLE_UI_MOTION,
  MAPLE_UI_RADIUS,
  MAPLE_UI_SPACING,
} from './generated/ui-tokens';

export const MapleTokens = {
  // Surfaces
  bg: MAPLE_UI_COLORS.bg,
  surface: MAPLE_UI_COLORS.surface,
  surfaceAlt: MAPLE_UI_COLORS.surfaceAlt,
  surfaceHover: MAPLE_UI_COLORS.surfaceHover,
  sidebar: MAPLE_UI_COLORS.sidebar,
  inputBg: MAPLE_UI_COLORS.inputBg,
  imageCanvas: MAPLE_UI_COLORS.imageCanvas,

  // Text
  textMain: MAPLE_UI_COLORS.textMain,
  textMuted: MAPLE_UI_COLORS.textMuted,

  // Borders
  border: MAPLE_UI_COLORS.border,
  // Active ticks (drag-bar center tick), grab handles. Responsive-program S0a (#581).
  borderHi: MAPLE_UI_COLORS.borderHi,

  // Accent
  primary: MAPLE_UI_COLORS.primary,
  primaryDim: MAPLE_UI_COLORS.primaryDim,

  // Low-confidence signals (e.g. person detection). Tailwind amber-400.
  // Responsive-program S0a (#581).
  warn: MAPLE_UI_COLORS.warn,

  // Hover/active overlays
  bgHover: MAPLE_UI_COLORS.bgHover,
  bgActive: MAPLE_UI_COLORS.bgActive,

  // Semantic
  successBg: MAPLE_UI_COLORS.successBg,
  successText: MAPLE_UI_COLORS.successText,
  errorBg: MAPLE_UI_COLORS.errorBg,
  errorText: MAPLE_UI_COLORS.errorText,
  star: MAPLE_UI_COLORS.star,

  // Motion. Kept here for back-compat — the canonical motion-token table
  // lives on `MapleMotion` (see motion.ts) and reads from the same
  // generated source.
  ease: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;

export type MapleTokenKey = keyof typeof MapleTokens;

// Font family stacks — kept in lockstep with tokens.scss `--font-*` vars.
// Bundled via @font-face in `fonts.scss` per spec §3.3.
export const MapleFont = `"Lato", -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif`;
export const MapleSerif = `"Merriweather", Georgia, "Times New Roman", serif`;
export const MapleMono = `"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace`;
