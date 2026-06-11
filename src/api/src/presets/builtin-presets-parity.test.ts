/**
 * Built-in presets parity gate (#1115).
 *
 * The CANONICAL built-in preset list is the shared JSON resource that
 * Apple bundles via Bundle.module:
 *
 *   src/apple/Packages/MapleCore/Sources/MapleCore/Resources/builtin-presets.json
 *
 * The web ships a compiled TS mirror (`builtin-presets.ts`) because
 * ng-packagr libraries can't import cross-tree JSON. This test is the
 * drift gate that pins the mirror to the canonical file — the same
 * convention as the tools/codegen.sh golden gates. It lives in src/api
 * because bun tests run with full repo + filesystem access on every CI
 * run, unlike the web's vitest (jsdom) and Apple's swift test (no cloud
 * CI).
 *
 * It also validates every built-in against the server-side preset
 * validator, so a bundled preset can never carry fields the API itself
 * would reject.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { BUILTIN_PRESETS } from '../../../web/projects/maple-common/src/lib/editor/presets/builtin-presets.ts';
import { validatePresetDocument } from './preset-validation.ts';

const CANONICAL_PATH = join(
  import.meta.dir,
  '../../../apple/Packages/MapleCore/Sources/MapleCore/Resources/builtin-presets.json',
);

interface CanonicalFile {
  schemaVersion: number;
  presets: Array<{
    id: string;
    schemaVersion: number;
    name: string;
    fields: Record<string, number | string | boolean>;
  }>;
}

describe('builtin-presets parity (canonical JSON ↔ web TS mirror)', () => {
  it('the web mirror deep-equals the canonical JSON resource', async () => {
    const canonical = (await Bun.file(CANONICAL_PATH).json()) as CanonicalFile;
    // The web constant adds the runtime-only `builtIn: true` marker; the
    // document keys must match exactly.
    const fromWeb = BUILTIN_PRESETS.map((p) => ({
      id: p.id,
      schemaVersion: p.schemaVersion,
      name: p.name,
      fields: p.fields,
    }));
    expect(fromWeb).toEqual(canonical.presets);
    expect(BUILTIN_PRESETS.every((p) => p.builtIn)).toBe(true);
  });

  it('every built-in passes the server-side preset validator', async () => {
    const canonical = (await Bun.file(CANONICAL_PATH).json()) as CanonicalFile;
    expect(canonical.presets.length).toBeGreaterThan(0);
    for (const preset of canonical.presets) {
      const res = validatePresetDocument(preset);
      expect(res).toEqual({
        ok: true,
        preset: {
          name: preset.name,
          schemaVersion: preset.schemaVersion,
          fields: preset.fields,
        },
      });
    }
  });

  it('built-in ids and names are unique and built-in ids are namespaced', async () => {
    const canonical = (await Bun.file(CANONICAL_PATH).json()) as CanonicalFile;
    const ids = canonical.presets.map((p) => p.id);
    const names = canonical.presets.map((p) => p.name.toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    for (const id of ids) expect(id.startsWith('builtin-')).toBe(true);
  });
});
