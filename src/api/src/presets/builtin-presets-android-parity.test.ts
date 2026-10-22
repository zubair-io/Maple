import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('Android built-in presets match the canonical JSON catalog', async () => {
  const canonical = await Bun.file(
    join(
      import.meta.dir,
      '../../../apple/Packages/MapleCore/Sources/MapleCore/Resources/builtin-presets.json',
    ),
  ).json();
  const source = await Bun.file(
    join(
      import.meta.dir,
      '../../../android/app/src/main/java/app/justmaple/aperture/ui/PresetsAndToneCurvePlot.kt',
    ),
  ).text();
  const definition = source.slice(
    source.indexOf('val builtInPresets:'),
    source.indexOf('fun MapleViewModel.applyBuiltInPreset'),
  );
  const constructor = /BuiltInPreset\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*mapOf\(([^)]*)\)\s*\)/g;
  const scalar = /"([^"]+)"\s+to\s+(-?\d+(?:\.\d+)?)f/g;
  const presets = [...definition.matchAll(constructor)].map((match) => {
    expect(match[3].replace(scalar, '').replace(/[\s,]/g, '')).toBe('');
    return {
      id: match[1],
      name: match[2],
      fields: Object.fromEntries(
        [...match[3].matchAll(scalar)].map((field) => [field[1], Number(field[2])]),
      ),
    };
  });
  // Unparsed constructors or expressions must fail, rather than disappear from the gate.
  expect(
    definition
      .replace(constructor, '')
      .replace(/val builtInPresets:\s*List<BuiltInPreset>\s*=\s*listOf/, '')
      .replace(/[\s,()]/g, ''),
  ).toBe('');
  expect(presets).toEqual(
    canonical.presets.map((preset: { id: string; name: string; fields: unknown }) => ({
      id: preset.id,
      name: preset.name,
      fields: preset.fields,
    })),
  );
});
