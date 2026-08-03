// ControlCardComponent — floating flyout panel beside the tool dock (#1535).
//
// Tablet/desktop: fixed 300px column, vertically centred just left of the
// dock (see editor-shell.component.scss `.control-card-anchor`). Header is
// an accent group glyph + title (FlyoutSliderPanel parity) — the dock owns
// group switching, so there is no chip row here. Sliders render as a single
// living-slider column for the active group.
//
// Phone (#1807 — CARD editor): the horizontal tool dock still owns group
// selection; the card is a closeable flyout driven by the `closed` input —
// closed hides the whole card and leaves only the dock visible. A close
// button in the header dismisses the panel back to the dock.
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
  /**
   * Phone layout (#1807): shows a close button in the header alongside the
   * group title, so the flyout can be dismissed back to the dock.
   */
  phone = input<boolean>(false);
  /**
   * Phone-only: the card is fully hidden, leaving just the dock. Driven by
   * the shell from dock taps — the card itself doesn't own open/closed
   * because opening is triggered by the dock, which lives outside this
   * component. Ignored (card always shown) when `phone` is false.
   */
  closed = input<boolean>(false);

  // ── Outputs ───────────────────────────────────────────────────────────
  /**
   * No longer fired by a group chip — that row is gone; the dock owns group
   * switching. Re-armed one step removed: the "Basic" entry of the colour
   * sub-tool row (`onSubtoolClick`, colour group only) emits this to re-arm
   * the group itself. Not part of the `phone`/`closed`/`closeRequest`
   * retirement — those are phone-flyout-only; this output is live for both
   * layouts.
   */
  groupChange = output<ToolGroup>();
  /** Fired when the user taps the phone close button. */
  closeRequest = output<void>();

  onCloseClick(): void {
    this.closeRequest.emit();
  }

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
