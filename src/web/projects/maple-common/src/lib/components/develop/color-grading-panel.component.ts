// ColorGradingPanelComponent — the Color Grading surface (#275).
//
// Four round wheels (Shadows / Midtones / Highlights / Global), each with
// a luminance slider under it, plus the balance slider that shifts the
// zone crossovers. This is the ONLY colour-toning surface in the editor:
// it supersedes the old Split Tone pill exactly as Lightroom's Color
// Grading panel superseded Split Toning, and the shadow/highlight
// hue+saturation pairs are still the `splitTone*` fields that ACR writes
// to `crs:SplitToning*`.
//
// Writes go straight to `LibraryStateService.updateAdjustment`, the same
// single write path the WB pad uses for its two-field puck.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import {
  ADJUSTMENT_RANGES,
  defaultGeneratedAdjustmentModel,
  type AdjustmentModel,
} from '../../models/adjustment-model';
import { ColorWheelComponent } from './color-wheel.component';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';
import type { WheelValue } from './color-wheel-math';

/** One wheel's three model fields. */
interface ZoneFields {
  readonly hue: keyof AdjustmentModel & string;
  readonly saturation: keyof AdjustmentModel & string;
  readonly luminance: keyof AdjustmentModel & string;
}

/** A zone row: label plus the fields its wheel and slider drive. */
export interface GradeZone extends ZoneFields {
  readonly id: 'shadows' | 'midtones' | 'highlights' | 'global';
  readonly label: string;
}

/**
 * The four zones in tonal order, global last. Shadow and highlight
 * hue/saturation live on the `splitTone*` fields — ACR's own layout.
 */
export const GRADE_ZONES: readonly GradeZone[] = [
  {
    id: 'shadows',
    label: 'Shadows',
    hue: 'splitToneShadowHue',
    saturation: 'splitToneShadowSaturation',
    luminance: 'colorGradeShadowLuminance',
  },
  {
    id: 'midtones',
    label: 'Midtones',
    hue: 'colorGradeMidtoneHue',
    saturation: 'colorGradeMidtoneSaturation',
    luminance: 'colorGradeMidtoneLuminance',
  },
  {
    id: 'highlights',
    label: 'Highlights',
    hue: 'splitToneHighlightHue',
    saturation: 'splitToneHighlightSaturation',
    luminance: 'colorGradeHighlightLuminance',
  },
  {
    id: 'global',
    label: 'Global',
    hue: 'colorGradeGlobalHue',
    saturation: 'colorGradeGlobalSaturation',
    luminance: 'colorGradeGlobalLuminance',
  },
];

const LUM_RANGE = ADJUSTMENT_RANGES.colorGradeMidtoneLuminance;
const BALANCE_RANGE = ADJUSTMENT_RANGES.splitToneBalance;
const BLENDING_RANGE = ADJUSTMENT_RANGES.colorGradeBlending;
const DEFAULTS = defaultGeneratedAdjustmentModel();
const SHADOW_EDGE_DEFAULT = DEFAULTS.colorGradeShadowEdge;
const HIGHLIGHT_EDGE_DEFAULT = DEFAULTS.colorGradeHighlightEdge;
const SHADOW_RANGE = ADJUSTMENT_RANGES.colorGradeShadowEdge;
const HIGHLIGHT_RANGE = ADJUSTMENT_RANGES.colorGradeHighlightEdge;

function smoothstep(e0: number, e1: number, x: number): number {
  const span = Math.max(e1 - e0, 1e-5);
  const t = Math.min(Math.max((x - e0) / span, 0), 1);
  return t * t * (3 - 2 * t);
}

// Snap to the anchor like raw-core's resolve_*_edge so a drag to the end equals the default, not 0.565.
const EDGE_KEY_DIRECTIONS: Readonly<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowDown: -1,
  ArrowRight: 1,
  ArrowUp: 1,
};

function edgeKeyValue(
  event: KeyboardEvent,
  current: number,
  min: number,
  max: number,
): number | undefined {
  if (event.key === 'Home') return min;
  if (event.key === 'End') return max;
  const direction = EDGE_KEY_DIRECTIONS[event.key];
  return direction === undefined ? undefined : current + direction * (event.shiftKey ? 0.05 : 0.01);
}

function snapEdge(norm: number, min: number, max: number): number {
  const rounded = Math.round(norm * 1000) / 1000;
  const snapped = Math.abs(rounded - SHADOW_EDGE_DEFAULT) < 0.005 ? SHADOW_EDGE_DEFAULT : rounded;
  return Math.min(Math.max(snapped, min), max);
}

function balanceExponent(balance: number): number {
  return Math.pow(2, -Math.min(Math.max(balance, BALANCE_RANGE[0]), BALANCE_RANGE[1]) / 100);
}

export function gradeEdgePlotPosition(edge: number, balance: number): number {
  return Math.pow(Math.min(Math.max(edge, 0), 1), 1 / balanceExponent(balance));
}

export function gradeEdgeValueAtPosition(position: number, balance: number): number {
  return Math.pow(Math.min(Math.max(position, 0), 1), balanceExponent(balance));
}

export function computeZoneWeights(
  l: number,
  balance: number,
  blending: number,
  shadowEdge: number,
  highlightEdge: number,
): [number, number, number] {
  const lClamped = Math.min(Math.max(l, 0), 1);
  const balanceExp = balanceExponent(balance);
  const lb = Math.pow(lClamped, balanceExp);
  const b = Math.min(Math.max(blending, 0), 100) / 100;
  const ls = Math.min(Math.max(shadowEdge, SHADOW_RANGE[0]), SHADOW_RANGE[1]);
  const lh = Math.min(Math.max(highlightEdge, HIGHLIGHT_RANGE[0]), HIGHLIGHT_RANGE[1]);
  const s0 = (1 - b) * Math.max(ls - 0.04, 0);
  const s1 = ls;
  const h0 = lh;
  const h1 = 1 - (1 - b) * Math.max(1 - lh - 0.04, 0);
  const wSh = 1 - smoothstep(s0, s1, lb);
  const wHi = smoothstep(h0, h1, lb);
  const wMid = Math.max(1 - wSh - wHi, 0);
  return [wSh, wMid, wHi];
}

@Component({
  selector: 'pro-color-grading-panel',
  standalone: true,
  imports: [ColorWheelComponent, MuiLivingSliderComponent],
  templateUrl: './color-grading-panel.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ColorGradingPanelComponent {
  private readonly library = inject(LibraryStateService);
  private readonly editor = inject(EditorStateService);
  readonly shadowMin = SHADOW_RANGE[0];
  readonly shadowMax = SHADOW_RANGE[1];
  readonly highlightMin = HIGHLIGHT_RANGE[0];
  readonly highlightMax = HIGHLIGHT_RANGE[1];

  readonly zones = GRADE_ZONES;
  readonly lumMin = LUM_RANGE[0];
  readonly lumMax = LUM_RANGE[1];
  readonly balanceMin = BALANCE_RANGE[0];
  readonly balanceMax = BALANCE_RANGE[1];
  readonly blendingMin = BLENDING_RANGE[0];
  readonly blendingMax = BLENDING_RANGE[1];

  private readonly adj = computed<AdjustmentModel | null>(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });

  readonly balance = computed<number>(() => this.adj()?.splitToneBalance ?? 0);
  readonly blending = computed<number>(
    () => this.adj()?.colorGradeBlending ?? DEFAULTS.colorGradeBlending,
  );
  readonly shadowEdge = computed<number>(
    () => this.adj()?.colorGradeShadowEdge ?? SHADOW_EDGE_DEFAULT,
  );
  readonly highlightEdge = computed<number>(
    () => this.adj()?.colorGradeHighlightEdge ?? HIGHLIGHT_EDGE_DEFAULT,
  );

  readonly zoneCurves = computed(() => {
    const bal = this.balance();
    const bl = this.blending();
    const shE = this.shadowEdge();
    const hiE = this.highlightEdge();
    const shPts: string[] = [];
    const midPts: string[] = [];
    const hiPts: string[] = [];
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = (t * 200).toFixed(1);
      const [wSh, wMid, wHi] = computeZoneWeights(t, bal, bl, shE, hiE);
      shPts.push(`${x},${((1 - wSh) * 80 + 4).toFixed(1)}`);
      midPts.push(`${x},${((1 - wMid) * 80 + 4).toFixed(1)}`);
      hiPts.push(`${x},${((1 - wHi) * 80 + 4).toFixed(1)}`);
    }
    return {
      sh: shPts.join(' '),
      mid: midPts.join(' '),
      hi: hiPts.join(' '),
    };
  });

  readonly shadowPlotPosition = computed(() =>
    gradeEdgePlotPosition(this.shadowEdge(), this.balance()),
  );
  readonly highlightPlotPosition = computed(() =>
    gradeEdgePlotPosition(this.highlightEdge(), this.balance()),
  );

  private activeEdgeDrag: { edge: 'shadow' | 'highlight'; pointerId: number } | null = null;

  /** Read one numeric field off the focused asset's adjustment model. */
  valueOf(field: keyof AdjustmentModel & string): number {
    const v = this.adj()?.[field];
    return typeof v === 'number' ? v : 0;
  }

  onWheelChange(zone: GradeZone, value: WheelValue): void {
    this.patch({ [zone.hue]: value.hue, [zone.saturation]: value.saturation });
  }

  onLuminanceChange(zone: GradeZone, value: number): void {
    this.patch({ [zone.luminance]: value });
  }

  onLuminanceReset(zone: GradeZone): void {
    this.patch({ [zone.luminance]: 0 });
  }

  onBalanceChange(value: number): void {
    this.patch({ splitToneBalance: value });
  }

  onBalanceReset(): void {
    this.patch({ splitToneBalance: 0 });
  }

  onBlendingChange(value: number): void {
    this.patch({ colorGradeBlending: value });
  }

  beginBlending(): void {
    this.editor.commit('adjustment', 'Colour grading blending');
  }

  endBlending(): void {
    this.editor.endEdit();
  }

  onBlendingReset(): void {
    this.editor.commit('adjustment', 'Reset colour grading blending');
    this.patch({ colorGradeBlending: DEFAULTS.colorGradeBlending });
    this.editor.endEdit();
  }

  onEdgeKeyDown(edge: 'shadow' | 'highlight', event: KeyboardEvent): void {
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      this.onEdgeReset(edge);
      return;
    }
    const min = edge === 'shadow' ? SHADOW_RANGE[0] : HIGHLIGHT_RANGE[0];
    const max = edge === 'shadow' ? SHADOW_RANGE[1] : HIGHLIGHT_RANGE[1];
    const current = edge === 'shadow' ? this.shadowEdge() : this.highlightEdge();
    const next = edgeKeyValue(event, current, min, max);
    if (next === undefined) return;
    event.preventDefault();
    this.editor.commit('adjustment', `Colour grading ${edge} edge`);
    this.patch(
      edge === 'shadow'
        ? { colorGradeShadowEdge: snapEdge(next, min, max) }
        : { colorGradeHighlightEdge: snapEdge(next, min, max) },
    );
    this.editor.endEdit();
  }

  onEdgePointerDown(edge: 'shadow' | 'highlight', event: PointerEvent): void {
    if (event.button !== 0 || this.activeEdgeDrag) return;
    event.preventDefault();
    this.editor.commit('adjustment', `Colour grading ${edge} edge`);
    this.activeEdgeDrag = { edge, pointerId: event.pointerId };
    (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId);
    this.updateEdgeFromEvent(edge, event);
  }

  onEdgePointerMove(event: PointerEvent): void {
    if (!this.activeEdgeDrag || event.pointerId !== this.activeEdgeDrag.pointerId) return;
    this.updateEdgeFromEvent(this.activeEdgeDrag.edge, event);
  }

  onEdgePointerUp(event?: PointerEvent): void {
    if (!this.activeEdgeDrag || (event && event.pointerId !== this.activeEdgeDrag.pointerId))
      return;
    this.activeEdgeDrag = null;
    this.editor.endEdit();
  }

  onEdgeReset(edge: 'shadow' | 'highlight'): void {
    this.editor.commit('adjustment', `Reset colour grading ${edge} edge`);
    if (edge === 'shadow') {
      this.patch({ colorGradeShadowEdge: SHADOW_EDGE_DEFAULT });
    } else {
      this.patch({ colorGradeHighlightEdge: HIGHLIGHT_EDGE_DEFAULT });
    }
    this.editor.endEdit();
  }

  private updateEdgeFromEvent(edge: 'shadow' | 'highlight', event: PointerEvent): void {
    const target = event.currentTarget as Element | null;
    const svg = target?.closest('svg') ?? target;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const norm = gradeEdgeValueAtPosition((event.clientX - rect.left) / rect.width, this.balance());
    if (edge === 'shadow') {
      this.patch({ colorGradeShadowEdge: snapEdge(norm, SHADOW_RANGE[0], SHADOW_RANGE[1]) });
    } else {
      this.patch({
        colorGradeHighlightEdge: snapEdge(norm, HIGHLIGHT_RANGE[0], HIGHLIGHT_RANGE[1]),
      });
    }
  }

  private patch(fields: Partial<AdjustmentModel>): void {
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.library.updateAdjustment(id, fields);
  }
}
