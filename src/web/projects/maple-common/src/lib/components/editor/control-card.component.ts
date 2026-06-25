// ControlCardComponent — floating glass card at bottom of canvas (#1535).
// Contains: group chip row (active = accent28 fill + accent border) +
// living-slider column (1 col phone / 2 col tablet+desktop) for the
// active group. Grab handle collapses between peek (chips only) and full.
// Reset button in header zeroes the visible group.
// Per-slider double-click zeroes that one slider (handled via resetRequest).

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
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

export type CardState = 'full' | 'peek';

const ALL_GROUPS: ToolGroup[] = ['light', 'color', 'effects', 'detail'];

/** Tools shown as sliders in the control card (excludes crop/presets/hsl). */
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

  // ── Outputs ───────────────────────────────────────────────────────────
  /** Fired when user taps a group chip. */
  groupChange = output<ToolGroup>();

  // ── Card collapse state ────────────────────────────────────────────────
  readonly cardState = signal<CardState>('full');
  readonly isPeek = computed(() => this.cardState() === 'peek');

  toggleCardState(): void {
    this.cardState.update((s) => (s === 'full' ? 'peek' : 'full'));
  }

  // ── Data helpers ──────────────────────────────────────────────────────
  readonly allGroups = ALL_GROUPS;

  groupLabel(g: ToolGroup): string {
    return TOOL_GROUP_DISPLAY[g];
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

  onSliderChange(tool: ToolId, value: number): void {
    const id = this.libraryState.focusedAssetId();
    if (!id || !isWired(tool)) return;
    const field = fieldFor(tool);
    if (!field) return;
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
