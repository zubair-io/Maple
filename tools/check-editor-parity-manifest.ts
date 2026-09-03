#!/usr/bin/env bun
// check-editor-parity-manifest.ts — the editor parity manifest checker
// (#2448, milestone 18 design spec §3.1). Runs in CI as cross.yml's
// `editor-parity-manifest` job, alongside `maple-ui-contracts`.
//
// The manifest (`src/web/.../editor/parity/editor-parity-manifest.ts`) is a
// hand-authored inventory of every editor capability and its native/web
// reachability. This script is a CHECKER, not a generator: it never emits
// code, it proves the manifest and the tree still agree —
//
//   1. every web `ToolId` (tool-model.ts) and every Apple `Tool` case
//      (ToolModel.swift) has exactly one row, and every row names a real
//      tool — so a new tool on either platform fails CI until it is
//      inventoried;
//   2. a native/web reachability difference without a documented
//      `exception` fails, and an `exception` left on a capability that is
//      now released on both platforms fails too (stale exceptions are the
//      way a closed gap silently stops being tracked);
//   3. a disabled placeholder (Mask, Heal) can never claim `released`, and
//      must carry a ticket;
//   4. a field-backed row's field exists in BOTH generated range tables with
//      the same bounds and a generated default, and its copy/paste group
//      matches the generated group tables — no third copy of ranges here;
//   5. rows tied to a `docs/features.md` §8 matrix row must agree with the
//      Apple and Web cells — the doc is checked, not generated (spec Open
//      decision 4).
//
// Usage: bun tools/check-editor-parity-manifest.ts [repo-root]

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  EditorParityManifest,
  ParityCapability,
  ParityReachability,
} from '../src/web/projects/maple-common/src/lib/editor/parity/editor-parity-types';

const WEB_LIB = 'src/web/projects/maple-common/src/lib';
export const PATHS = {
  manifest: `${WEB_LIB}/editor/parity/editor-parity-manifest.ts`,
  toolModel: `${WEB_LIB}/editor/tool-model.ts`,
  tsTables: `${WEB_LIB}/generated/adjustment-tables.generated.ts`,
  tsModel: `${WEB_LIB}/generated/adjustment-model.generated.ts`,
  swiftToolModel: 'src/apple/Packages/MapleCore/Sources/MapleCore/Editor/ToolModel.swift',
  swiftGenerated:
    'src/apple/Packages/MapleCore/Sources/MapleCore/Generated/AdjustmentModel+Generated.swift',
  features: 'docs/features.md',
} as const;

export type Range = readonly [number, number];

export interface FeaturesCells {
  readonly apple: string;
  readonly webSelfHosted: string;
  readonly webHosted: string;
}

export interface CheckInputs {
  readonly manifest: EditorParityManifest;
  readonly webToolIds: readonly string[];
  readonly appleToolCases: readonly string[];
  readonly tsRanges: Readonly<Record<string, Range>>;
  readonly tsDefaults: Readonly<Record<string, unknown>>;
  readonly tsGroups: readonly { readonly id: string; readonly fields: readonly string[] }[];
  readonly swiftRanges: Readonly<Record<string, Range>>;
  readonly featuresMatrix: ReadonlyMap<string, FeaturesCells>;
}

const REACHABILITY: readonly ParityReachability[] = ['released', 'partial', 'absent'];
const GROUPS = [
  'light',
  'color',
  'effects',
  'detail',
  'shell',
  'input',
  'canvas',
  'navigation',
  'history',
  'scopes',
  'clipboard',
  'export',
] as const;
const PREVIEW = ['live', 'commit-on-release', 'none'] as const;
const TOOL_GROUPS: readonly string[] = ['light', 'color', 'effects', 'detail'];

// ── Parsers ───────────────────────────────────────────────────────────────

/** Every member of the `export type ToolId = | 'a' | 'b' …;` union. */
export function parseWebToolIds(source: string): string[] {
  const union = source.match(/export type ToolId =([\s\S]*?);/);
  if (!union) throw new Error('tool-model.ts: `export type ToolId =` union not found');
  return Array.from(union[1].matchAll(/'([A-Za-z0-9]+)'/g), (m) => m[1]);
}

/** Every `case` of `public enum Tool: String` (multi-case lines included). */
export function parseSwiftToolCases(source: string): string[] {
  const start = source.indexOf('public enum Tool: String');
  if (start < 0) throw new Error('ToolModel.swift: `public enum Tool: String` not found');
  const body = source.slice(start);
  const end = body.search(/\n\s+public var /);
  const cases = end < 0 ? body : body.slice(0, end);
  return Array.from(cases.matchAll(/^\s*case ([A-Za-z0-9_,\s]+)$/gm), (m) => m[1])
    .flatMap((line) => line.split(','))
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** `public static let <field>Range: ClosedRange<Double> = lo...hi` → { field: [lo, hi] }. */
export function parseSwiftRanges(source: string): Record<string, Range> {
  const pattern = /public static let (\w+)Range: ClosedRange<Double> = (-?[\d.]+)\.\.\.(-?[\d.]+)/g;
  return Object.fromEntries(
    Array.from(source.matchAll(pattern), (m) => [m[1], [Number(m[2]), Number(m[3])] as Range]),
  );
}

/**
 * The `## 8. Per-platform matrix` table: row label → the Apple, Web (Self
 * Hosted) and Web (Hosted) cells, located by header name so a reordered
 * or added column cannot silently shift the comparison.
 */
export function parseFeaturesMatrix(markdown: string): Map<string, FeaturesCells> {
  const sectionStart = markdown.indexOf('## 8. Per-platform matrix');
  if (sectionStart < 0) throw new Error('features.md: `## 8. Per-platform matrix` not found');
  const lines = markdown
    .slice(sectionStart)
    .split('\n')
    .filter((line) => line.trim().startsWith('|'));
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
  const header = cells(lines[0] ?? '');
  const column = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`features.md §8: column '${name}' not found`);
    return index;
  };
  const apple = column('Apple');
  const selfHosted = column('Web (Self Hosted)');
  const hosted = column('Web (Hosted)');
  const rows = lines.slice(2).map(cells);
  return new Map(
    rows.map((row) => [
      row[0],
      {
        apple: row[apple] ?? '',
        webSelfHosted: row[selfHosted] ?? '',
        webHosted: row[hosted] ?? '',
      },
    ]),
  );
}

/** A §8 cell's reachability: `no` / `no UI` is absent, `yes…` / `via…` /
 *  `both` is released, anything else (`facet only`, `ratings + flags`) is
 *  partial. */
export function cellReachability(cell: string): ParityReachability {
  const text = cell.trim().toLowerCase();
  if (/^no\b/.test(text)) return 'absent';
  if (/^(yes|via|both)\b/.test(text)) return 'released';
  return 'partial';
}

const camelToSnake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// ── Checks ────────────────────────────────────────────────────────────────

function checkShape(row: ParityCapability, fail: (msg: string) => void): void {
  const id = row.id || '<missing id>';
  if (!row.id) fail(`a capability has no id`);
  if (!row.name) fail(`${id}: missing name`);
  if (!GROUPS.includes(row.group)) fail(`${id}: unknown group '${row.group}'`);
  if (typeof row.order !== 'number') fail(`${id}: order must be a number`);
  for (const platform of ['apple', 'web'] as const) {
    if (!REACHABILITY.includes(row.reachability?.[platform])) {
      fail(`${id}: reachability.${platform} must be one of ${REACHABILITY.join(', ')}`);
    }
  }
  for (const [block, keys] of [
    ['presentation', ['compact', 'regular', 'wide']],
    ['interaction', ['keyboard', 'pointer', 'touch', 'focus']],
    ['accessibility', ['role', 'name', 'value', 'state']],
  ] as const) {
    const value = row[block] as Record<string, unknown> | undefined;
    for (const key of keys) {
      if (typeof value?.[key] !== 'string' || (value[key] as string).trim() === '') {
        fail(`${id}: ${block}.${key} must be a non-empty string`);
      }
    }
  }
  if (!Array.isArray(row.accessibility?.actions) || row.accessibility.actions.length === 0) {
    fail(`${id}: accessibility.actions must list at least one action`);
  }
  const participation = row.participation;
  if (
    typeof participation?.undo !== 'boolean' ||
    typeof participation.history !== 'boolean' ||
    typeof participation.export !== 'boolean' ||
    !PREVIEW.includes(participation.preview)
  ) {
    fail(`${id}: participation must declare undo/history/export booleans and a preview mode`);
  }
  if (row.tool && !TOOL_GROUPS.includes(row.group)) {
    fail(`${id}: a tool row must use one of the four editor groups, got '${row.group}'`);
  }
  const exception = row.exception;
  if (exception) {
    if (!['apple', 'web', 'both'].includes(exception.platform)) {
      fail(`${id}: exception.platform must be apple, web or both`);
    }
    if (!exception.rationale?.trim()) fail(`${id}: exception.rationale must be non-empty`);
    if (exception.ticket !== null && !/^#\d+$/.test(exception.ticket ?? '')) {
      fail(`${id}: exception.ticket must be '#<number>' or null`);
    }
  }
}

function checkToolEnums(inputs: CheckInputs, fail: (msg: string) => void): void {
  const rows = inputs.manifest.capabilities;
  const compare = (platform: 'web' | 'apple', real: readonly string[], label: string): void => {
    const declared = rows
      .map((row) => row.tool?.[platform] ?? null)
      .filter((tool): tool is string => tool !== null);
    const seen = new Set<string>();
    for (const tool of declared) {
      if (seen.has(tool)) fail(`${label} tool '${tool}' has more than one manifest row`);
      seen.add(tool);
    }
    for (const tool of real) {
      if (!seen.has(tool)) fail(`${label} tool '${tool}' has no manifest row`);
    }
    for (const tool of seen) {
      if (!real.includes(tool))
        fail(`manifest names ${label} tool '${tool}', which does not exist`);
    }
  };
  compare('web', inputs.webToolIds, 'web');
  compare('apple', inputs.appleToolCases, 'Apple');
}

function checkReachability(row: ParityCapability, fail: (msg: string) => void): void {
  const { apple, web } = row.reachability;
  const differs = apple !== web;
  if (differs && !row.exception) {
    fail(`${row.id}: apple=${apple} web=${web} differ with no documented exception`);
  }
  if (!differs && apple === 'released' && row.exception) {
    fail(`${row.id}: released on both platforms but still carries an exception — remove it`);
  }
  if (row.disabled) {
    if (apple === 'released' || web === 'released') {
      fail(`${row.id}: a disabled placeholder cannot be released on either platform`);
    }
    if (!row.exception?.ticket) {
      fail(`${row.id}: a disabled placeholder must carry an exception with a ticket`);
    }
  }
}

function checkField(row: ParityCapability, inputs: CheckInputs, fail: (msg: string) => void): void {
  const field = row.field;
  if (!field) return;
  const ts = inputs.tsRanges[field];
  const swift = inputs.swiftRanges[field];
  if (!ts) fail(`${row.id}: field '${field}' has no generated web range`);
  if (!swift) fail(`${row.id}: field '${field}' has no generated Apple range`);
  if (ts && swift && (ts[0] !== swift[0] || ts[1] !== swift[1])) {
    fail(`${row.id}: field '${field}' range drift — web [${ts}] vs Apple [${swift}]`);
  }
  if (typeof inputs.tsDefaults[field] !== 'number') {
    fail(`${row.id}: field '${field}' has no numeric generated default`);
  }
  const expectedGroup =
    inputs.tsGroups.find((group) => group.fields.includes(camelToSnake(field)))?.id ?? null;
  if (row.participation.copyPaste !== expectedGroup) {
    fail(
      `${row.id}: participation.copyPaste is ${row.participation.copyPaste} but the generated ` +
        `copy groups place '${field}' in ${expectedGroup}`,
    );
  }
}

function checkFeaturesRow(
  row: ParityCapability,
  matrix: ReadonlyMap<string, FeaturesCells>,
  fail: (msg: string) => void,
): void {
  if (!row.featuresRow) return;
  const cells = matrix.get(row.featuresRow);
  if (!cells) {
    fail(`${row.id}: docs/features.md §8 has no row '${row.featuresRow}'`);
    return;
  }
  const apple = cellReachability(cells.apple);
  if (apple !== row.reachability.apple) {
    fail(
      `${row.id}: features.md §8 '${row.featuresRow}' Apple cell '${cells.apple}' reads as ` +
        `${apple}, manifest says ${row.reachability.apple}`,
    );
  }
  for (const [column, cell] of [
    ['Web (Self Hosted)', cells.webSelfHosted],
    ['Web (Hosted)', cells.webHosted],
  ] as const) {
    const web = cellReachability(cell);
    if (web !== row.reachability.web) {
      fail(
        `${row.id}: features.md §8 '${row.featuresRow}' ${column} cell '${cell}' reads as ` +
          `${web}, manifest says ${row.reachability.web}`,
      );
    }
  }
}

/** Every failure message, empty when the manifest and the tree agree. */
export function checkManifest(inputs: CheckInputs): string[] {
  const failures: string[] = [];
  const fail = (msg: string) => failures.push(msg);
  const rows = inputs.manifest.capabilities;
  if (rows.length === 0) fail('manifest has no capabilities');
  const ids = new Set<string>();
  const orders = new Set<string>();
  for (const row of rows) {
    checkShape(row, fail);
    if (ids.has(row.id)) fail(`duplicate capability id '${row.id}'`);
    ids.add(row.id);
    const slot = `${row.group}:${row.order}`;
    if (orders.has(slot)) fail(`${row.id}: order ${row.order} already used in group ${row.group}`);
    orders.add(slot);
    checkReachability(row, fail);
    checkField(row, inputs, fail);
    checkFeaturesRow(row, inputs.featuresMatrix, fail);
  }
  checkToolEnums(inputs, fail);
  return failures;
}

// ── CLI ───────────────────────────────────────────────────────────────────

export async function loadInputs(root: string): Promise<CheckInputs> {
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const manifestModule = (await import(join(root, PATHS.manifest))) as {
    EDITOR_PARITY_MANIFEST: EditorParityManifest;
  };
  const tables = (await import(join(root, PATHS.tsTables))) as {
    ADJUSTMENT_RANGES: Record<string, Range>;
    ADJUSTMENT_GROUPS: readonly { id: string; fields: readonly string[] }[];
  };
  const model = (await import(join(root, PATHS.tsModel))) as {
    defaultGeneratedAdjustmentModel: () => Record<string, unknown>;
  };
  return {
    manifest: manifestModule.EDITOR_PARITY_MANIFEST,
    webToolIds: parseWebToolIds(read(PATHS.toolModel)),
    appleToolCases: parseSwiftToolCases(read(PATHS.swiftToolModel)),
    tsRanges: tables.ADJUSTMENT_RANGES,
    tsDefaults: model.defaultGeneratedAdjustmentModel(),
    tsGroups: tables.ADJUSTMENT_GROUPS,
    swiftRanges: parseSwiftRanges(read(PATHS.swiftGenerated)),
    featuresMatrix: parseFeaturesMatrix(read(PATHS.features)),
  };
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const inputs = await loadInputs(root);
  const failures = checkManifest(inputs);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log(
    `OK: ${inputs.manifest.capabilities.length} capabilities checked against ` +
      `${inputs.webToolIds.length} web tools, ${inputs.appleToolCases.length} Apple tools, ` +
      `${Object.keys(inputs.swiftRanges).length} generated ranges and docs/features.md §8`,
  );
}
