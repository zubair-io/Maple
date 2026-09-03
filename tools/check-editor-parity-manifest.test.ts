// Self-test for tools/check-editor-parity-manifest.ts — exercises the
// parsers on inline snippets and `checkManifest` on an in-memory manifest,
// mutating one thing at a time to prove each rule fires (same role as
// check-maple-ui-contracts.test.sh for the contract linter). Runs first in
// cross.yml's `editor-parity-manifest` job:
//
//   bun test tools/check-editor-parity-manifest.test.ts

import { describe, expect, it } from 'bun:test';
import type {
  EditorParityManifest,
  ParityCapability,
} from '../src/web/projects/maple-common/src/lib/editor/parity/editor-parity-types';
import {
  cellReachability,
  checkManifest,
  parseFeaturesMatrix,
  parseSwiftRanges,
  parseSwiftToolCases,
  parseWebToolIds,
  type CheckInputs,
} from './check-editor-parity-manifest';

const TOOL_MODEL_TS = `
export type ToolGroup = 'light' | 'color';

export type ToolId =
  // Light
  | 'exposure'
  | 'contrast'
  // Detail
  | 'crop';

export const TOOL_DISPLAY = { exposure: 'Exposure' };
`;

const TOOL_MODEL_SWIFT = `
public enum ToolGroup: String, CaseIterable { case light }

public enum Tool: String, CaseIterable, Sendable, Hashable {
    // Light
    case exposure, contrast, toneCurve
    // Detail
    case captureSharpen, crop

    public var group: ToolGroup {
        switch self {
        case .exposure: return .light
        }
    }
}
`;

const GENERATED_SWIFT = `
extension AdjustmentModel {
    public static let exposureRange: ClosedRange<Double> = -4.0...4.0
    public static let contrastRange: ClosedRange<Double> = -100.0...100.0
    public static let captureSharpeningAmountRange: ClosedRange<Double> = 0.0...100.0
}
`;

const FEATURES_MD = `
## 7. Settings

| Feature | Apple |
| ------- | ----- |
| Thing   | yes   |

## 8. Per-platform matrix

| Feature                            | Apple  | Web (Self Hosted) | Web (Hosted) | Windows | Apple TV |
| ---------------------------------- | ------ | ----------------- | ------------ | ------- | -------- |
| Editor (develop)                   | yes    | yes               | yes          | yes     | no       |
| Capture sharpening (deconvolution) | yes    | no                | no           | no      | no       |
| AUTO                               | no UI  | yes               | yes          | yes     | no       |
| Export                             | yes (+HEIC, no resize) | yes | yes        | yes     | no       |

Trailing prose, then an unrelated table that must NOT leak into the matrix:

| Feature | Apple | Web (Self Hosted) | Web (Hosted) |
| ------- | ----- | ----------------- | ------------ |
| Leak    | no    | no                | no           |
`;

const BLOCKS = {
  presentation: { compact: 'c', regular: 'r', wide: 'w' },
  interaction: { keyboard: 'k', pointer: 'p', touch: 't', focus: 'f' },
  accessibility: { role: 'slider', name: 'n', value: 'v', state: 's', actions: ['adjust'] },
} as const;

const EDIT = {
  undo: true,
  copyPaste: 'tone',
  history: true,
  preview: 'live',
  export: true,
} as const;
const NONE = {
  undo: false,
  copyPaste: null,
  history: false,
  preview: 'none',
  export: false,
} as const;

function row(
  overrides: Partial<ParityCapability> & Pick<ParityCapability, 'id'>,
): ParityCapability {
  return {
    name: overrides.id,
    group: 'light',
    order: 10,
    reachability: { apple: 'released', web: 'released' },
    ...BLOCKS,
    participation: NONE,
    exception: null,
    ...overrides,
  };
}

const GOOD_ROWS: readonly ParityCapability[] = [
  row({
    id: 'tool.exposure',
    tool: { web: 'exposure', apple: 'exposure' },
    field: 'exposure',
    participation: EDIT,
    featuresRow: 'Editor (develop)',
  }),
  row({
    id: 'tool.contrast',
    order: 20,
    tool: { web: 'contrast', apple: 'contrast' },
    field: 'contrast',
    participation: EDIT,
  }),
  row({ id: 'tool.toneCurve', order: 30, tool: { web: null, apple: 'toneCurve' } }),
  row({
    id: 'tool.captureSharpen',
    group: 'detail',
    tool: { web: null, apple: 'captureSharpen' },
    field: 'captureSharpeningAmount',
    reachability: { apple: 'released', web: 'absent' },
    participation: { ...EDIT, copyPaste: 'detail' },
    exception: { platform: 'web', rationale: 'needs a GPU path', ticket: null },
    featuresRow: 'Capture sharpening (deconvolution)',
  }),
  row({ id: 'tool.crop', group: 'detail', order: 20, tool: { web: 'crop', apple: 'crop' } }),
  row({
    id: 'shell.placeholder-mask',
    group: 'shell',
    reachability: { apple: 'absent', web: 'absent' },
    disabled: true,
    exception: { platform: 'both', rationale: 'no UI yet', ticket: '#1541' },
  }),
  row({
    id: 'shell.auto',
    group: 'shell',
    order: 20,
    reachability: { apple: 'absent', web: 'released' },
    exception: { platform: 'apple', rationale: 'no view calls it', ticket: '#3249' },
    featuresRow: 'AUTO',
  }),
];

function inputs(capabilities: readonly ParityCapability[] = GOOD_ROWS): CheckInputs {
  const manifest: EditorParityManifest = { version: 1, capabilities };
  return {
    manifest,
    webToolIds: parseWebToolIds(TOOL_MODEL_TS),
    appleToolCases: parseSwiftToolCases(TOOL_MODEL_SWIFT),
    tsRanges: { exposure: [-4, 4], contrast: [-100, 100], captureSharpeningAmount: [0, 100] },
    tsDefaults: { exposure: 0, contrast: 0, captureSharpeningAmount: 0 },
    tsGroups: [
      { id: 'tone', fields: ['exposure', 'contrast'] },
      { id: 'detail', fields: ['capture_sharpening_amount'] },
    ],
    swiftRanges: parseSwiftRanges(GENERATED_SWIFT),
    featuresMatrix: parseFeaturesMatrix(FEATURES_MD),
  };
}

function replace(id: string, patch: Partial<ParityCapability>): ParityCapability[] {
  return GOOD_ROWS.map((r) => (r.id === id ? { ...r, ...patch } : r));
}

describe('parsers', () => {
  it('reads every member of the web ToolId union', () => {
    expect(parseWebToolIds(TOOL_MODEL_TS)).toEqual(['exposure', 'contrast', 'crop']);
  });

  it('reads every Apple Tool case, including comma-separated lines', () => {
    expect(parseSwiftToolCases(TOOL_MODEL_SWIFT)).toEqual([
      'exposure',
      'contrast',
      'toneCurve',
      'captureSharpen',
      'crop',
    ]);
  });

  it('reads the generated Swift ranges', () => {
    expect(parseSwiftRanges(GENERATED_SWIFT)).toEqual({
      exposure: [-4, 4],
      contrast: [-100, 100],
      captureSharpeningAmount: [0, 100],
    });
  });

  it('reads the §8 matrix by column name and skips earlier tables', () => {
    const matrix = parseFeaturesMatrix(FEATURES_MD);
    expect(matrix.get('AUTO')).toEqual({ apple: 'no UI', webSelfHosted: 'yes', webHosted: 'yes' });
    expect(matrix.get('Export')?.apple).toBe('yes (+HEIC, no resize)');
    expect(matrix.has('Thing')).toBe(false);
    expect(matrix.has('Leak')).toBe(false);
  });

  it('maps matrix cells onto reachability', () => {
    expect(cellReachability('yes')).toBe('released');
    expect(cellReachability('yes (+HEIC, no resize)')).toBe('released');
    expect(cellReachability('via curve panel')).toBe('released');
    expect(cellReachability('no')).toBe('absent');
    expect(cellReachability('no UI')).toBe('absent');
    expect(cellReachability('facet only')).toBe('partial');
  });
});

describe('checkManifest', () => {
  it('passes a manifest that agrees with the tree', () => {
    expect(checkManifest(inputs())).toEqual([]);
  });

  it('fails a web tool with no row', () => {
    const rows = GOOD_ROWS.filter((r) => r.id !== 'tool.crop');
    expect(checkManifest(inputs(rows))).toContain("web tool 'crop' has no manifest row");
    expect(checkManifest(inputs(rows))).toContain("Apple tool 'crop' has no manifest row");
  });

  it('fails a row naming a tool that does not exist', () => {
    const rows = [
      ...GOOD_ROWS,
      row({ id: 'tool.bogus', order: 99, tool: { web: 'bogus', apple: null } }),
    ];
    expect(checkManifest(inputs(rows))).toContain(
      "manifest names web tool 'bogus', which does not exist",
    );
  });

  it('fails two rows claiming the same tool', () => {
    const rows = [
      ...GOOD_ROWS,
      row({ id: 'tool.exposure2', order: 99, tool: { web: 'exposure', apple: null } }),
    ];
    expect(checkManifest(inputs(rows))).toContain(
      "web tool 'exposure' has more than one manifest row",
    );
  });

  it('fails an undocumented native/web difference', () => {
    const rows = replace('tool.contrast', { reachability: { apple: 'released', web: 'absent' } });
    expect(checkManifest(inputs(rows))).toContain(
      'tool.contrast: apple=released web=absent differ with no documented exception',
    );
  });

  it('fails an exception that names the wrong side', () => {
    const rows = replace('shell.auto', {
      exception: { platform: 'web', rationale: 'swapped', ticket: '#3249' },
    });
    expect(checkManifest(inputs(rows))).toContain(
      "shell.auto: exception.platform is 'web' but reachability is apple=absent web=released — " +
        'name the side that lacks the capability',
    );
    const both = replace('tool.captureSharpen', {
      exception: { platform: 'both', rationale: 'x', ticket: null },
    });
    expect(checkManifest(inputs(both))).toContain(
      "tool.captureSharpen: exception.platform is 'both' but reachability is apple=released " +
        'web=absent — name the side that lacks the capability',
    );
  });

  it('fails a stale exception on a capability released on both platforms', () => {
    const rows = replace('shell.auto', {
      reachability: { apple: 'released', web: 'released' },
      featuresRow: undefined,
    });
    expect(checkManifest(inputs(rows))).toContain(
      'shell.auto: released on both platforms but still carries an exception — remove it',
    );
  });

  it('fails a disabled placeholder that claims released or lacks a ticket', () => {
    const released = replace('shell.placeholder-mask', {
      reachability: { apple: 'absent', web: 'released' },
    });
    expect(checkManifest(inputs(released))).toContain(
      'shell.placeholder-mask: a disabled placeholder cannot be released on either platform',
    );
    const noTicket = replace('shell.placeholder-mask', {
      exception: { platform: 'both', rationale: 'x', ticket: null },
    });
    expect(checkManifest(inputs(noTicket))).toContain(
      'shell.placeholder-mask: a disabled placeholder must carry an exception with a ticket',
    );
  });

  it('fails generated range drift between web and Apple', () => {
    const drifted = {
      ...inputs(),
      swiftRanges: { ...inputs().swiftRanges, contrast: [-100, 150] as const },
    };
    expect(checkManifest(drifted)).toContain(
      "tool.contrast: field 'contrast' range drift — web [-100,100] vs Apple [-100,150]",
    );
  });

  it('fails a field missing from either generated table or its default', () => {
    const rows = replace('tool.contrast', { field: 'texture' });
    const failures = checkManifest(inputs(rows));
    expect(failures).toContain("tool.contrast: field 'texture' has no generated web range");
    expect(failures).toContain("tool.contrast: field 'texture' has no generated Apple range");
    expect(failures).toContain("tool.contrast: field 'texture' has no numeric generated default");
  });

  it('fails a copy/paste group that disagrees with the generated groups', () => {
    const rows = replace('tool.exposure', { participation: { ...EDIT, copyPaste: 'color' } });
    expect(checkManifest(inputs(rows))).toContain(
      "tool.exposure: participation.copyPaste is color but the generated copy groups place 'exposure' in tone",
    );
  });

  it('fails docs/features.md §8 drift and an unknown row', () => {
    const drift = replace('shell.auto', {
      reachability: { apple: 'partial', web: 'released' },
    });
    expect(checkManifest(inputs(drift))).toContain(
      "shell.auto: features.md §8 'AUTO' Apple cell 'no UI' reads as absent, manifest says partial",
    );
    const unknown = replace('shell.auto', { featuresRow: 'Nope' });
    expect(checkManifest(inputs(unknown))).toContain(
      "shell.auto: docs/features.md §8 has no row 'Nope'",
    );
  });

  it('fails duplicate ids, duplicate orders and empty required strings', () => {
    const dup = [...GOOD_ROWS, row({ id: 'tool.exposure', order: 50 })];
    expect(checkManifest(inputs(dup))).toContain("duplicate capability id 'tool.exposure'");
    const order = [...GOOD_ROWS, row({ id: 'light.other', order: 10 })];
    expect(checkManifest(inputs(order))).toContain(
      'light.other: order 10 already used in group light',
    );
    const empty = replace('tool.crop', { interaction: { ...BLOCKS.interaction, focus: ' ' } });
    expect(checkManifest(inputs(empty))).toContain(
      'tool.crop: interaction.focus must be a non-empty string',
    );
  });

  it('fails a tool row outside the four editor groups', () => {
    const rows = replace('tool.crop', { group: 'shell', order: 77 });
    expect(checkManifest(inputs(rows))).toContain(
      "tool.crop: a tool row must use one of the four editor groups, got 'shell'",
    );
  });
});
