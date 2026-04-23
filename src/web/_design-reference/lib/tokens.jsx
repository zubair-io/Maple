// Just Maple dark theme tokens — sourced directly from the spec.
const MapleTokens = {
  // surfaces
  bg:            '#1c1917',
  surface:       '#262524',
  surfaceAlt:    '#2e2c2a',
  surfaceHover:  '#3a3836',
  sidebar:       '#292524',
  inputBg:       '#1c1917',
  imageCanvas:   '#141210',

  // text
  textMain:      '#e7e5e4',
  textMuted:     '#a8a29e',

  // borders
  border:        '#44403c',

  // accent
  primary:       '#c4493a',
  primaryDim:    '#422016',

  // hover/active overlays
  bgHover:       'rgba(255,255,255,0.06)',
  bgActive:      'rgba(255,255,255,0.10)',

  // semantic
  successBg:     'rgba(34,197,94,0.15)',
  successText:   '#4ade80',
  errorBg:       'rgba(239,68,68,0.15)',
  errorText:     '#f87171',
  star:          '#EF9F27',

  // motion
  ease:          'cubic-bezier(0.22, 1, 0.36, 1)',
};

const MapleFont = `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif`;
const MapleMono = `"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace`;

Object.assign(window, { MapleTokens, MapleFont, MapleMono });
