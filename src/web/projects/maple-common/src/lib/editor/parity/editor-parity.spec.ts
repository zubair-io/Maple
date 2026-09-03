// editor-parity.spec.ts — the web-internal half of the parity manifest
// contract (#2448). The Bun checker (`tools/check-editor-parity-manifest.ts`)
// owns the cross-language checks (Apple enum, Swift ranges, features.md);
// this spec proves what only the web module graph can: every `ToolId` maps
// to one row whose group and primary field match `tool-model.ts`, every
// field-backed row is fully described by the generated metadata, and the
// disabled placeholders can never be presented as working controls.

import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, fieldFor, groupOf, type ToolId } from '../tool-model';
import { subParamsFor } from '../tool-sub-param';
import { fieldMetadata, isSchemaField, toolMetadata } from '../tool-metadata';
import {
  EDITOR_PARITY_MANIFEST,
  isReleasedOnWeb,
  parityCapability,
  parityForWebTool,
  parityPlaceholders,
} from './editor-parity';

describe('editor parity manifest — web tool coverage', () => {
  it('maps every ToolId to exactly one row, in its tool-model group', () => {
    for (const tool of ALL_TOOLS) {
      const row = parityForWebTool(tool);
      expect(row, `no manifest row for '${tool}'`).not.toBeNull();
      expect(row!.group).toBe(groupOf(tool));
      expect(row!.tool?.web).toBe(tool);
    }
    const webTools = EDITOR_PARITY_MANIFEST.capabilities
      .map((row) => row.tool?.web ?? null)
      .filter((tool): tool is ToolId => tool !== null);
    expect(new Set(webTools).size).toBe(webTools.length);
    expect(webTools.length).toBe(ALL_TOOLS.length);
  });

  it("names each tool's primary field exactly as tool-model.ts does", () => {
    for (const tool of ALL_TOOLS) {
      const row = parityForWebTool(tool)!;
      const primary = fieldFor(tool);
      const expected = primary !== null && isSchemaField(primary) ? primary : null;
      expect(row.field ?? null, `field for '${tool}'`).toBe(expected);
    }
  });

  it('has generated metadata (range, default, step, decimals, copy group) for every field-backed row', () => {
    for (const row of EDITOR_PARITY_MANIFEST.capabilities) {
      if (!row.field) continue;
      const meta = fieldMetadata(row.field);
      expect(meta.range[0]).toBeLessThan(meta.range[1]);
      expect(meta.defaultValue).toBeGreaterThanOrEqual(meta.range[0]);
      expect(meta.defaultValue).toBeLessThanOrEqual(meta.range[1]);
      expect(meta.step).toBeGreaterThan(0);
      expect(meta.decimals).toBeGreaterThanOrEqual(0);
      expect(meta.copyGroup, `copy group for '${row.field}'`).toBe(row.participation.copyPaste);
    }
  });

  it('covers every sub-param field with generated metadata too', () => {
    for (const tool of ALL_TOOLS) {
      for (const sub of subParamsFor(tool)) {
        const meta = fieldMetadata(sub.field);
        expect(meta.range[0]).toBeLessThan(meta.range[1]);
        expect(typeof meta.defaultValue).toBe('number');
      }
    }
  });

  it('gives each slider tool the metadata the control card and HUD use', () => {
    expect(toolMetadata('exposure')).toMatchObject({ step: 0.01, decimals: 2, copyGroup: 'tone' });
    expect(toolMetadata('temp')).toMatchObject({
      step: 50,
      decimals: 0,
      copyGroup: 'white_balance',
    });
    expect(toolMetadata('colorNR')).toMatchObject({
      defaultValue: 25,
      step: 1,
      copyGroup: 'detail',
    });
    expect(toolMetadata('hsl')).toBeNull();
    expect(toolMetadata('presets')).toBeNull();
  });
});

describe('editor parity manifest — placeholders and exceptions', () => {
  it('keeps the Heal placeholder disabled with a ticket, never released (Mask shipped in #1541)', () => {
    const placeholders = parityPlaceholders();
    expect(placeholders.map((row) => row.id).sort()).toEqual(['shell.placeholder-heal']);
    for (const row of placeholders) {
      expect(row.reachability.web).not.toBe('released');
      expect(row.reachability.apple).not.toBe('released');
      expect(row.exception?.ticket).toMatch(/^#\d+$/);
      expect(isReleasedOnWeb(row.id)).toBe(false);
    }
  });

  it('documents every native/web difference with an exception', () => {
    for (const row of EDITOR_PARITY_MANIFEST.capabilities) {
      if (row.reachability.apple !== row.reachability.web) {
        expect(row.exception, `${row.id} differs without an exception`).not.toBeNull();
        expect(row.exception!.rationale.length).toBeGreaterThan(0);
      }
    }
  });

  it('answers reachability queries for released and unknown capabilities', () => {
    expect(isReleasedOnWeb('tool.exposure')).toBe(true);
    expect(isReleasedOnWeb('input.slider-wheel-nudge')).toBe(false);
    expect(isReleasedOnWeb('nope')).toBe(false);
    expect(parityCapability('canvas.zoom')?.name).toContain('Zoom');
    expect(parityCapability('nope')).toBeNull();
  });
});
