import { describe, it, expect } from 'vitest';

import { MapleFont, MapleMono, MapleSerif, MapleTokens } from './tokens';

// Sanity-level checks on the typography stacks per
// docs/spec/responsive-program-s0-primitives.md §3.3. The runtime font
// load is verified by the Playwright spec at src/web/e2e/fonts.spec.ts —
// here we only assert that the family stacks themselves declare the
// bundled face first (so falling back to the system font requires the
// bundled face to fail to load, not for it to be missing from the stack).

describe('Typography token stacks', () => {
  it('MapleFont begins with bundled Lato', () => {
    expect(MapleFont.startsWith('"Lato"')).toBe(true);
  });

  it('MapleSerif begins with bundled Merriweather', () => {
    expect(MapleSerif.startsWith('"Merriweather"')).toBe(true);
  });

  it('MapleMono begins with bundled JetBrains Mono', () => {
    expect(MapleMono.startsWith('"JetBrains Mono"')).toBe(true);
  });

  it('color token table is unchanged', () => {
    // Drive-by guard against accidental token deletion when this file is
    // edited for typography reasons.
    expect(MapleTokens.bg).toBe('#1c1917');
    expect(MapleTokens.primary).toBe('#c4493a');
  });
});
