// editor-parity.ts — runtime access to the editor parity manifest (#2448).
//
// The shell reads capability state from here instead of hand-written
// literals, so "Mask is disabled, see #1541" is said once (in the manifest)
// rather than once per platform. The manifest itself is data in
// `editor-parity-manifest.ts`; the CI checker in
// `tools/check-editor-parity-manifest.ts` keeps it honest.

import type { ToolId } from '../tool-model';
import { EDITOR_PARITY_MANIFEST } from './editor-parity-manifest';
import type { ParityCapability } from './editor-parity-types';

export { EDITOR_PARITY_MANIFEST } from './editor-parity-manifest';

const BY_ID: ReadonlyMap<string, ParityCapability> = new Map(
  EDITOR_PARITY_MANIFEST.capabilities.map((capability) => [capability.id, capability]),
);

const BY_WEB_TOOL: ReadonlyMap<ToolId, ParityCapability> = new Map(
  EDITOR_PARITY_MANIFEST.capabilities.flatMap((capability) =>
    capability.tool?.web ? [[capability.tool.web, capability] as const] : [],
  ),
);

/** The manifest row for a capability id, or `null`. */
export function parityCapability(id: string): ParityCapability | null {
  return BY_ID.get(id) ?? null;
}

/** The manifest row that owns a web tool, or `null` for an unmapped id
 *  (the checker guarantees every `ToolId` maps, so `null` only shows up
 *  for a tool added without a manifest row). */
export function parityForWebTool(tool: ToolId): ParityCapability | null {
  return BY_WEB_TOOL.get(tool) ?? null;
}

/** Integrated-but-unreleased placeholders (`disabled: true`) — the dock
 *  renders these dimmed and out of the accessibility tree, never as
 *  working controls, with the exception ticket as the tooltip. */
export function parityPlaceholders(): readonly ParityCapability[] {
  return EDITOR_PARITY_MANIFEST.capabilities.filter((capability) => capability.disabled === true);
}

/** True when the web shell may present the capability as a working
 *  control: released on web and not a placeholder. */
export function isReleasedOnWeb(id: string): boolean {
  const capability = BY_ID.get(id);
  return (
    capability !== undefined && !capability.disabled && capability.reachability.web === 'released'
  );
}
