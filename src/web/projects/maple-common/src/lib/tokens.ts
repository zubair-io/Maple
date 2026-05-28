// TypeScript mirror of tokens.scss — for use in component logic (not styles).
// Values must stay in sync with tokens.scss.

export const MapleTokens = {
  // Surfaces
  bg: '#1c1917',
  surface: '#262524',
  surfaceAlt: '#2e2c2a',
  surfaceHover: '#3a3836',
  sidebar: '#292524',
  inputBg: '#1c1917',
  imageCanvas: '#141210',

  // Text
  textMain: '#e7e5e4',
  textMuted: '#a8a29e',

  // Borders
  border: '#44403c',
  // Active ticks (drag-bar center tick), grab handles. Responsive-program S0a (#581).
  borderHi: '#5a5552',

  // Accent
  primary: '#c4493a',
  primaryDim: '#422016',

  // Low-confidence signals (e.g. person detection). Tailwind amber-400.
  // Responsive-program S0a (#581).
  warn: '#fbbf24',

  // Hover/active overlays
  bgHover: 'rgba(255, 255, 255, 0.06)',
  bgActive: 'rgba(255, 255, 255, 0.10)',

  // Semantic
  successBg: 'rgba(34, 197, 94, 0.15)',
  successText: '#4ade80',
  errorBg: 'rgba(239, 68, 68, 0.15)',
  errorText: '#f87171',
  star: '#EF9F27',

  // Motion
  ease: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;

export type MapleTokenKey = keyof typeof MapleTokens;

// Font family stacks — kept in lockstep with tokens.scss `--font-*` vars.
// Bundled via @font-face in `fonts.scss` per spec §3.3.
export const MapleFont = `"Lato", -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif`;
export const MapleSerif = `"Merriweather", Georgia, "Times New Roman", serif`;
export const MapleMono = `"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace`;
