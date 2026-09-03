// editor-parity-manifest.tools.ts — the TOOL rows of the editor parity
// manifest (#2448): one row per web `ToolId` (tool-model.ts) and per Apple
// `Tool` case (ToolModel.swift). `tools/check-editor-parity-manifest.ts`
// proves the mapping is a bijection in both directions, so adding a tool on
// either platform without a row fails CI. The rows themselves live in
// `editor-parity-manifest.light-color.ts` / `.effects-detail.ts` (one file
// per pair of groups, for the file-size budget), built from the shared
// slider / panel builders in `editor-parity-manifest.builders.ts`; chrome,
// input and canvas rows live in `editor-parity-manifest.ts`.
//
// The three Apple-only cases are documented rather than mirrored: the tone
// curve is a first-class dock panel on web (no `ToolId`, same panel), and
// the capture-sharpening pair is the one approved permanent platform
// exception (`docs/features.md` §8).

import type { ParityCapability } from './editor-parity-types';
import { COLOR_TOOLS, LIGHT_TOOLS } from './editor-parity-manifest.light-color';
import { DETAIL_TOOLS, EFFECTS_TOOLS } from './editor-parity-manifest.effects-detail';

export const TOOL_CAPABILITIES: readonly ParityCapability[] = [
  ...LIGHT_TOOLS,
  ...COLOR_TOOLS,
  ...EFFECTS_TOOLS,
  ...DETAIL_TOOLS,
];
