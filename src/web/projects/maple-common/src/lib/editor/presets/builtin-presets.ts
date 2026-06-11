// builtin-presets.ts — bundled utility presets (#1115, spec §10.7).
//
// The CANONICAL definition is the shared JSON resource at
// `src/apple/Packages/MapleCore/Sources/MapleCore/Resources/builtin-presets.json`
// (Apple bundles + parses that exact file via Bundle.module). This module
// is the web's compiled mirror of it — ng-packagr libraries can't import
// cross-tree JSON, so the mirror is TEST-PINNED instead: the bun-side
// parity gate at `src/api/src/presets/builtin-presets-parity.test.ts`
// asserts this constant deep-equals the canonical JSON, the same
// "one source, drift-gated mirrors" convention tools/codegen.sh uses.
//
// Built-ins are read-only utility presets — honest, descriptive names
// only (no film-stock or color-claim names for math we don't do).

import type { Preset } from './preset-model';

export const BUILTIN_PRESETS: readonly Preset[] = [
  {
    id: 'builtin-flat',
    schemaVersion: 1,
    name: 'Flat',
    fields: { contrast: -50 },
    builtIn: true,
  },
  {
    id: 'builtin-high-contrast',
    schemaVersion: 1,
    name: 'High Contrast',
    fields: { contrast: 50 },
    builtIn: true,
  },
  {
    id: 'builtin-monochrome',
    schemaVersion: 1,
    name: 'Monochrome',
    fields: { saturation: -100 },
    builtIn: true,
  },
  {
    id: 'builtin-no-sharpening',
    schemaVersion: 1,
    name: 'No Sharpening',
    fields: { sharpen_amount: 0 },
    builtIn: true,
  },
  {
    id: 'builtin-no-color-nr',
    schemaVersion: 1,
    name: 'No Color NR',
    fields: { nr_color: 0 },
    builtIn: true,
  },
];

/** True when a (trimmed) name collides with a built-in preset name —
 *  used to refuse saving user presets under a built-in's name. */
export function collidesWithBuiltinName(name: string): boolean {
  const lowered = name.trim().toLowerCase();
  return BUILTIN_PRESETS.some((p) => p.name.toLowerCase() === lowered);
}
