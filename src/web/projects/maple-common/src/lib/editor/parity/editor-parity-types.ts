// editor-parity-types.ts — the shape of the editor surface + interaction
// parity manifest (#2448, milestone 18 design spec §3.1).
//
// The manifest is a hand-authored inventory of every released editor
// capability — a tool, a chrome control, a canvas/navigation/history
// primitive — and how each presents, behaves, and announces itself on the
// Apple app and in the browser. It is DATA, not code: nothing generates UI
// from it. Two consumers read it:
//
//   - `tools/check-editor-parity-manifest.ts` (CI, `cross.yml`
//     `editor-parity-manifest` job) cross-references it against the two real
//     tool enumerations (web's `ToolId` union in `tool-model.ts`, Apple's
//     `Tool` enum in `ToolModel.swift`), the generated adjustment tables on
//     both platforms, and `docs/features.md` §8 — so an undocumented
//     native/web difference, a stale exception, or a tool missing a row
//     fails the build.
//   - `editor-parity.ts` (runtime) exposes the rows to the web shell so the
//     tool dock's disabled placeholders and their tickets come from one
//     place (#2449) rather than a hand-written literal per platform.
//
// Ranges, defaults and steps are deliberately NOT in here: they stay in the
// generated tables (`adjustment-tables.generated.ts`, `AdjustmentModel+
// Generated.swift`) and `tool-metadata.ts` derives the rest — the manifest
// only names the FIELD so the checker can prove both platforms agree.

import type { ToolGroup, ToolId } from '../tool-model';
import type {
  ADJUSTMENT_RANGES,
  AdjustmentGroupId,
} from '../../generated/adjustment-tables.generated';

/** How reachable a capability is on one platform. `partial` = present but
 *  inconsistent or incomplete (e.g. a primitive that only one of two
 *  slider implementations carries). */
export type ParityReachability = 'released' | 'partial' | 'absent';

export type ParityPlatform = 'apple' | 'web';

/** Tool rows use the four editor groups; chrome rows use the region they
 *  live in, matching `editor-shell.component.html`'s own region names. */
export type ParityGroup =
  | ToolGroup
  | 'shell'
  | 'input'
  | 'canvas'
  | 'navigation'
  | 'history'
  | 'scopes'
  | 'clipboard'
  | 'export';

/** How a capability's edits reach the preview. */
export type ParityPreview = 'live' | 'commit-on-release' | 'none';

/** Schema field names carrying a generated range. */
export type ParityField = keyof typeof ADJUSTMENT_RANGES;

/**
 * An intentional, documented native/web asymmetry. `platform` names the
 * side that LACKS the capability (`both` for net-new gaps on both
 * platforms). `ticket` is the issue that closes the gap, or `null` for an
 * approved permanent exception (Apple's capture-sharpening pair).
 */
export interface ParityException {
  readonly platform: ParityPlatform | 'both';
  readonly rationale: string;
  readonly ticket: `#${number}` | null;
}

export interface ParityPresentation {
  /** Phone (`LayoutService.layout() === 'phone'`, <768px). */
  readonly compact: string;
  /** Tablet (768–1024px). */
  readonly regular: string;
  /** Desktop (>1024px). */
  readonly wide: string;
}

export interface ParityInteraction {
  readonly keyboard: string;
  readonly pointer: string;
  readonly touch: string;
  /** What a focused instance consumes vs. lets bubble to the shell. */
  readonly focus: string;
}

export interface ParityAccessibility {
  readonly role: string;
  readonly name: string;
  readonly value: string;
  readonly state: string;
  readonly actions: readonly string[];
}

export interface ParityParticipation {
  readonly undo: boolean;
  /** Copy/paste/sync group the capability's fields belong to, or `null`
   *  when nothing about it is copyable. Checked against the generated
   *  `ADJUSTMENT_GROUPS` for field-backed rows. */
  readonly copyPaste: AdjustmentGroupId | null;
  readonly history: boolean;
  readonly preview: ParityPreview;
  /** True when the capability's state bakes into an export. */
  readonly export: boolean;
}

export interface ParityCapability {
  /** Stable id, `<group>.<slug>` — e.g. `tool.exposure`, `canvas.zoom-keyboard`. */
  readonly id: string;
  readonly name: string;
  readonly group: ParityGroup;
  /** Presentation order within `group`; unique per group. */
  readonly order: number;
  /** Code-level identity when the capability IS a tool: the web `ToolId`
   *  and the Apple `Tool` case, `null` on a platform that reaches the
   *  capability by another route (the tone curve is a dock panel on web). */
  readonly tool?: { readonly web: ToolId | null; readonly apple: string | null };
  /** Primary `AdjustmentModel` field, when the capability drives one. */
  readonly field?: ParityField | null;
  readonly reachability: Readonly<Record<ParityPlatform, ParityReachability>>;
  readonly presentation: ParityPresentation;
  readonly interaction: ParityInteraction;
  readonly accessibility: ParityAccessibility;
  readonly participation: ParityParticipation;
  /** Integrated-but-unreleased placeholder: rendered disabled, never as a
   *  working control. Requires an `exception` with a ticket. */
  readonly disabled?: boolean;
  readonly exception: ParityException | null;
  /** Row label in `docs/features.md` §8 whose Apple / Web cells this
   *  capability's reachability must agree with. */
  readonly featuresRow?: string;
}

export interface EditorParityManifest {
  readonly version: number;
  readonly capabilities: readonly ParityCapability[];
}
