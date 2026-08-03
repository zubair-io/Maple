// ControlCardComponent — floating flyout panel beside the tool dock (#1535).
//
// Tablet/desktop: fixed 300px column, vertically centred just left of the
// dock (see editor-shell.component.scss `.control-card-anchor`). Header is
// an accent group glyph + title (FlyoutSliderPanel parity) — the dock owns
// GROUP switching, so there is no group-chip row here. Sliders render as a
// single living-slider column for the active group.
//
// Sub-tool row (#1807 Task 4): HSL, B&W and Colour Grading have no single
// primary slider field, so they can't join SLIDER_TOOLS below. A Basic/…
// chip row shows for any group that has field-less tools (`showSubtools`)
// and swaps the body for content the shell projects in via
// `[cardBodySubParam]`/`[cardBodyGrade]` — this component never imports
// those panel components directly, so its own import list stays small.
// Group-parameterised (review correction, not the original design): Colour
// Grading's real group is Effects (`TOOLS_IN_GROUP.effects`), so a single
// Colour-only row containing Grade would hide itself the instant it's
// armed — arming it flips `activeGroup` to 'effects', off the row that
// launched it. So Colour gets `Basic · HSL · B&W`, Effects gets
// `Basic · Grade`, and Light/Detail get no row at all (see `SUBTOOLS`).
//
// Phone (#1807 Task 5 — CARD editor): the horizontal tool dock still owns
// group selection; the card itself is always visible, stacked directly
// above the dock (`EditorShellComponent`'s `.phone-card-anchor`) — same as
// tablet/desktop, just full-width instead of a fixed 300px column. There is
// no closeable-flyout state here any more.
//
// Reset button in header zeroes the visible group.
// Per-slider double-click zeroes that one slider (handled via resetRequest).

import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { LivingSliderComponent } from '../develop/living-slider.component';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import {
  type ToolGroup,
  type ToolId,
  TOOL_GROUP_DISPLAY,
  TOOL_DISPLAY,
  displayRange,
  fieldFor,
  defaultDisplayValue,
  isWired,
} from '../../editor/tool-model';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { gradientFor } from '../develop/gradient-catalog';
import type { AdjustmentModel } from '../../models/adjustment-model';

/** Tools shown as sliders in the control card (excludes crop/presets/hsl/
 *  bwMix — bwMix (#276) has no single primary drag-bar field, same reason
 *  as hsl: it surfaces the toggle + 8 gray-mixer sub-params via its own
 *  panel instead). */
const SLIDER_TOOLS: Partial<Record<ToolGroup, readonly ToolId[]>> = {
  light: ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
  color: ['temp', 'tint', 'vibrance', 'saturation'],
  effects: ['clarity', 'texture', 'dehaze', 'vignette', 'grain'],
  detail: ['sharpen', 'noise', 'colorNR'],
};

/** A sub-tool row entry: `id` is the `ToolId` it arms, `null` for Basic —
 *  the group's plain sliders. */
interface Subtool {
  readonly id: ToolId | null;
  readonly label: string;
}

/** Field-less tools that need their own row instead of a slider, by the
 *  group each genuinely belongs to (`groupOf` / `TOOLS_IN_GROUP` in
 *  tool-model.ts) — NOT by which group's sliders they're conceptually
 *  "about". Colour Grading reads as a colour tool but its real group is
 *  Effects, so it lives in the Effects row, not Colour's. Groups absent
 *  here (Light, Detail) have no field-less tools and get no row. Mirrors
 *  the tools Apple's Card variant cannot reach at all (ToolDock.swift has no
 *  button for any of them). */
const SUBTOOLS: Partial<Record<ToolGroup, readonly Subtool[]>> = {
  color: [
    { id: null, label: 'Basic' },
    { id: 'hsl', label: 'HSL' },
    { id: 'bwMix', label: 'B&W' },
  ],
  effects: [
    { id: null, label: 'Basic' },
    { id: 'colorGrade', label: 'Grade' },
  ],
};

@Component({
  selector: 'pro-control-card',
  standalone: true,
  imports: [LivingSliderComponent, MapleIconComponent],
  templateUrl: './control-card.component.html',
  styleUrl: './control-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ControlCardComponent {
  private editorState = inject(EditorStateService);
  private libraryState = inject(LibraryStateService);

  // ── Inputs ────────────────────────────────────────────────────────────
  /** Currently active tool group. */
  activeGroup = input.required<ToolGroup>();
  /** Armed tool — drives which sub-tool chip reads active. */
  activeTool = input<ToolId | null>(null);

  // ── Outputs ───────────────────────────────────────────────────────────
  /**
   * No longer fired by a group chip — that row is gone; the dock owns group
   * switching. Re-armed one step removed: the "Basic" entry of the sub-tool
   * row (`onSubtoolClick`, any group with field-less tools — Colour or
   * Effects) emits this to re-arm the group itself, but only when a plain
   * slider is already armed there (see `onSubtoolClick`).
   */
  groupChange = output<ToolGroup>();
  /** Fired when the user picks a sub-tool chip (HSL / B&W / Grade). */
  toolChange = output<ToolId>();

  // ── Data helpers ──────────────────────────────────────────────────────
  groupLabel(g: ToolGroup): string {
    return TOOL_GROUP_DISPLAY[g];
  }

  /** Accent glyph beside the group title — same icon the dock's group button
   *  uses, so the panel header and the dock entry read as the same object. */
  groupIcon(group: ToolGroup): string {
    const icons: Record<ToolGroup, string> = {
      light: 'tool-exposure',
      color: 'tool-tint',
      effects: 'tool-vignette',
      detail: 'tool-sharpen',
    };
    return icons[group];
  }

  /** Tools that appear as sliders for a given group. */
  slidersFor(group: ToolGroup): readonly ToolId[] {
    return SLIDER_TOOLS[group] ?? [];
  }

  /** Sub-tool chips for the active group, or empty when it has none
   *  (Light/Detail). */
  readonly subtools = computed<readonly Subtool[]>(() => SUBTOOLS[this.activeGroup()] ?? []);

  /** Sub-tool row shows only for a group that has field-less tools. */
  readonly showSubtools = computed<boolean>(() => this.subtools().length > 0);

  /** Whether `id` (or Basic, for `null`) is the armed field-less tool for
   *  the active group's row — shared by the template highlight and by
   *  `onSubtoolClick`'s own escape check below. */
  private isArmedSubtool(id: ToolId | null): boolean {
    return this.subtools().some((s) => s.id !== null && s.id === id);
  }

  isSubtoolActive(id: ToolId | null): boolean {
    const armed = this.activeTool();
    return id === null ? !this.isArmedSubtool(armed) : id === armed;
  }

  onSubtoolClick(id: ToolId | null): void {
    if (id !== null) {
      // The others arm directly, exactly as their former dock buttons did.
      this.toolChange.emit(id);
      return;
    }
    // Basic re-arms the group, which arms its first slider tool — but
    // `groupChange` alone only does that when a DIFFERENT group was
    // previously armed. `EditorStateService.armGroup` deliberately RETAINS
    // the currently-armed tool when the group doesn't change (see its
    // 'retains tool when arming the same group' spec) — the right behavior
    // for the dock's own group buttons (re-tapping Color shouldn't reset you
    // off Saturation), but every sub-tool in `subtools()` already belongs to
    // the active group, so that retain rule would otherwise leave Basic a
    // permanent no-op exactly when it's needed: escaping HSL/bwMix/Grade
    // back to plain sliders. Arm the group's first slider tool directly in
    // that case; otherwise a plain slider is already armed, so just
    // re-affirm the group (also emitted from a plain-slider tap so
    // `groupChange` stays live for callers other than the escape case
    // above).
    const firstSlider = this.slidersFor(this.activeGroup())[0];
    if (this.isArmedSubtool(this.activeTool()) && firstSlider) this.toolChange.emit(firstSlider);
    else this.groupChange.emit(this.activeGroup());
  }

  /** Current adjustment model for the focused asset. */
  readonly currentAdj = computed<AdjustmentModel | null>(() => {
    const id = this.libraryState.focusedAssetId();
    if (!id) return null;
    return this.libraryState.adjustmentFor(id)();
  });

  valueFor(tool: ToolId): number {
    const adj = this.currentAdj();
    if (!adj) return defaultDisplayValue(tool);
    const field = fieldFor(tool);
    if (!field) return defaultDisplayValue(tool);
    return adj[field] as number;
  }

  minFor(tool: ToolId): number {
    return displayRange(tool)?.[0] ?? -100;
  }

  maxFor(tool: ToolId): number {
    return displayRange(tool)?.[1] ?? 100;
  }

  stepFor(tool: ToolId): number {
    // Exposure is float; most others are integer
    if (tool === 'exposure') return 0.01;
    if (tool === 'temp') return 50;
    return 1;
  }

  labelFor(tool: ToolId): string {
    return TOOL_DISPLAY[tool];
  }

  gradientFor(tool: ToolId): string {
    return gradientFor(tool, null);
  }

  bipolarFor(tool: ToolId): boolean {
    const r = displayRange(tool);
    if (!r) return false;
    // Bipolar if range is symmetric around zero: lo === -hi
    return r[0] === -r[1];
  }

  defaultFor(tool: ToolId): number {
    return defaultDisplayValue(tool);
  }

  isBipolar(tool: ToolId): boolean {
    return this.bipolarFor(tool);
  }

  // ── Value edits ───────────────────────────────────────────────────────

  /**
   * Gesture-boundary handler (#2411): `LivingSliderComponent` fires
   * `dragStart` once — before its first `valueChange` tick, whether the
   * gesture is a pointer drag or a held arrow key — so this is the single
   * place to snapshot the pre-edit value onto the undo stack. Mirrors
   * `DragBarComponent.onPointerDown`'s `commit()` call for the drag-bar
   * control. `onSliderChange` below must NOT also commit — it runs once per
   * tick, and one undo entry per gesture (not per tick) is the whole point.
   */
  onSliderDragStart(tool: ToolId): void {
    const id = this.libraryState.focusedAssetId();
    if (!id || !isWired(tool)) return;
    this.editorState.commit();
  }

  onSliderChange(tool: ToolId, value: number): void {
    const id = this.libraryState.focusedAssetId();
    if (!id || !isWired(tool)) return;
    const field = fieldFor(tool);
    if (!field) return;
    // Arm the tool being dragged, mirroring Apple's `LivingSliderRow` (#1876)
    // so the value chip and the sub-param panel follow the active slider.
    // On web this is also what makes a multi-param tool's extra tiers
    // reachable — the Noise pill's Deep / Prefilter (#1153).
    if (this.editorState.armedTool() !== tool) this.editorState.armTool(tool);
    this.libraryState.updateAdjustment(id, { [field]: value } as Partial<AdjustmentModel>);
  }

  onSliderReset(tool: ToolId): void {
    const id = this.libraryState.focusedAssetId();
    if (!id || !isWired(tool)) return;
    const field = fieldFor(tool);
    if (!field) return;
    this.editorState.commit();
    this.libraryState.updateAdjustment(id, {
      [field]: defaultDisplayValue(tool),
    } as Partial<AdjustmentModel>);
    this.editorState.haptic('reset');
  }

  /** Reset all sliders in the active group. */
  resetGroup(): void {
    const id = this.libraryState.focusedAssetId();
    if (!id) return;
    const tools = this.slidersFor(this.activeGroup());
    if (tools.length === 0) return;
    this.editorState.commit();
    const patch: Partial<AdjustmentModel> = {};
    for (const tool of tools) {
      const field = fieldFor(tool);
      if (field) {
        (patch as Record<string, number>)[field] = defaultDisplayValue(tool);
      }
    }
    this.libraryState.updateAdjustment(id, patch);
    this.editorState.haptic('reset');
  }
}
