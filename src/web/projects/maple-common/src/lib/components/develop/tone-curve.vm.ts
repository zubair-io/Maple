// tone-curve.vm.ts — view model for the tone curve widget (#367).
//
// Holds every derivation the template reads (channel tabs, the SVG path
// strings, the knot list, the histogram polygon, the four parametric
// slider descriptors) so the component class is left with pointer
// handling and the two write paths. Co-located `.vm.ts`, per the #299
// precedent and `docs/best-practices.md` § "Components build a view
// model".
//
// Geometry: the plot is a `PLOT_SIZE`-square SVG user-space box. `x`
// runs left→right and `y` bottom→top in the authoring domain, so every
// y is flipped once, here, on the way into SVG space. Nothing downstream
// re-flips.

import { computed, signal, type Signal } from '@angular/core';
import {
  ADJUSTMENT_RANGES,
  type AdjustmentModel,
  type ToneCurve,
  type ToneCurvePoint,
} from '../../models/adjustment-model';
import { curvePathData } from './tone-curve-math';
import { materializeCurve } from './tone-curve-edit';

/** The four curves the channel selector switches between. */
export type CurveChannel = 'luma' | 'r' | 'g' | 'b';

/**
 * Which point-curve FAMILY the plot edits (#2232). `sceneLinear`
 * (`papp:SceneLinearToneCurve*`) applies pre-AgX in scene-linear light —
 * the original #367 family. `display` (`crs:ToneCurvePV2012*`) applies
 * post-AgX in display-linear `[0, 1]`, independently per channel — not
 * luma-coupled, matching Adobe Camera Raw's own point-curve behaviour.
 * Both families can be authored on the same image at once; this toggle
 * only changes which one the widget is currently editing.
 */
export type CurveFamily = 'sceneLinear' | 'display';

/** A channel tab: its id, its label, and the model field it edits. */
export interface ChannelTab {
  readonly id: CurveChannel;
  readonly label: string;
  readonly field:
    | 'toneCurveLuma'
    | 'toneCurveRed'
    | 'toneCurveGreen'
    | 'toneCurveBlue'
    | 'displayToneCurveLuma'
    | 'displayToneCurveRed'
    | 'displayToneCurveGreen'
    | 'displayToneCurveBlue';
  /** Stroke colour for this channel's curve. */
  readonly stroke: string;
}

const SCENE_LINEAR_TABS: readonly ChannelTab[] = [
  { id: 'luma', label: 'Luma', field: 'toneCurveLuma', stroke: 'var(--pro-accent)' },
  { id: 'r', label: 'R', field: 'toneCurveRed', stroke: 'var(--pro-curve-r)' },
  { id: 'g', label: 'G', field: 'toneCurveGreen', stroke: 'var(--pro-curve-g)' },
  { id: 'b', label: 'B', field: 'toneCurveBlue', stroke: 'var(--pro-curve-b)' },
];

const DISPLAY_TABS: readonly ChannelTab[] = [
  { id: 'luma', label: 'Master', field: 'displayToneCurveLuma', stroke: 'var(--pro-accent)' },
  { id: 'r', label: 'R', field: 'displayToneCurveRed', stroke: 'var(--pro-curve-r)' },
  { id: 'g', label: 'G', field: 'displayToneCurveGreen', stroke: 'var(--pro-curve-g)' },
  { id: 'b', label: 'B', field: 'displayToneCurveBlue', stroke: 'var(--pro-curve-b)' },
];

/** Family selector entries — id plus the label the toggle shows. */
export interface FamilyTab {
  readonly id: CurveFamily;
  readonly label: string;
}

const FAMILY_TABS: readonly FamilyTab[] = [
  { id: 'sceneLinear', label: 'Scene' },
  { id: 'display', label: 'Display' },
];

/** One parametric region slider. */
export interface ParametricSlider {
  readonly field:
    | 'parametricHighlights'
    | 'parametricLights'
    | 'parametricDarks'
    | 'parametricShadows';
  readonly label: string;
}

/** Bright → dark, matching the order the regions appear on the plot. */
const PARAMETRIC_SLIDERS: readonly ParametricSlider[] = [
  { field: 'parametricHighlights', label: 'Highlights' },
  { field: 'parametricLights', label: 'Lights' },
  { field: 'parametricDarks', label: 'Darks' },
  { field: 'parametricShadows', label: 'Shadows' },
];

/** SVG user-space extent of the square plot. */
export const PLOT_SIZE = 100;

/** Knot hit radius, in authoring-domain units (≈ 7px on a 240px plot). */
export const HIT_RADIUS = 0.045;

/** Both parametric ends; all four fields share the ±100 span. */
const PARAMETRIC_RANGE = ADJUSTMENT_RANGES.parametricHighlights;

/** A knot as the template draws it: SVG coordinates plus its list index. */
export interface PlottedKnot {
  readonly index: number;
  readonly cx: number;
  readonly cy: number;
  /** Endpoints are pinned in `x`; the template announces that. */
  readonly pinned: boolean;
  /** Output level 0–100, the single number `aria-valuenow` can carry. */
  readonly valueNow: number;
  /**
   * Both axes as percentages, for `aria-valuetext`.
   *
   * A knot is a 2-D control on a 1-D ARIA slider: the arrow keys move `x`
   * as well as `y`, so `aria-valuenow` alone announces an unchanged value
   * for every ArrowLeft/ArrowRight. `aria-valuetext` overrides what
   * assistive tech speaks, so it carries the input level too.
   */
  readonly valueText: string;
}

/**
 * Build the tone-curve view model over a model signal and a live-drag
 * override.
 *
 * `dragOverride` is the in-flight point list during a pointer drag. It
 * exists so the plot repaints at pointer rate while the MODEL write —
 * and therefore the WASM render round trip — stays coalesced to one per
 * animation frame (see `ToneCurveComponent`). When no drag is running it
 * is `null` and everything reads straight off the model.
 */
export function buildToneCurveViewModel(
  model: Signal<AdjustmentModel | null>,
  lumaHistogram: Signal<Uint32Array | null>,
) {
  const channel = signal<CurveChannel>('luma');
  const family = signal<CurveFamily>('sceneLinear');
  const dragOverride = signal<readonly ToneCurvePoint[] | null>(null);

  /** The active family's tab list — the four scene-linear or the four
   * display-referred curves (#2232). */
  const tabs = computed<readonly ChannelTab[]>(() =>
    family() === 'display' ? DISPLAY_TABS : SCENE_LINEAR_TABS,
  );

  const activeTab = computed<ChannelTab>(() => {
    const list = tabs();
    return list.find((t) => t.id === channel()) ?? list[0];
  });

  /** The committed point list for the active channel. */
  const committedPoints = computed<readonly ToneCurvePoint[]>(() => {
    const m = model();
    if (!m) return [];
    const curve = m[activeTab().field] as ToneCurve | undefined;
    return curve?.points ?? [];
  });

  /** What the plot shows: the drag override if one is live, else the model. */
  const points = computed<readonly ToneCurvePoint[]>(() => dragOverride() ?? committedPoints());

  const curvePath = computed<string>(() => curvePathData(points(), PLOT_SIZE));

  const knots = computed<readonly PlottedKnot[]>(() => {
    const list = materializeCurve(points());
    return list.map((p, index) => {
      const inputPct = Math.round(p[0] * 100);
      const outputPct = Math.round(p[1] * 100);
      return {
        index,
        cx: p[0] * PLOT_SIZE,
        cy: (1 - p[1]) * PLOT_SIZE,
        pinned: index === 0 || index === list.length - 1,
        valueNow: outputPct,
        valueText: `input ${inputPct}%, output ${outputPct}%`,
      };
    });
  });

  /** True when the active channel is untouched — drives the Reset button. */
  const isIdentity = computed<boolean>(() => committedPoints().length === 0);

  /**
   * The luma histogram as a filled SVG polygon, log-compressed so the
   * shadow bins stay legible against a single blown highlight spike.
   * Recomputed only when the decoded pixel buffer changes — never per
   * drag tick.
   */
  const histogramPath = computed<string>(() => {
    const hist = lumaHistogram();
    if (!hist || hist.length === 0) return '';
    const peak = hist.reduce((a, b) => (b > a ? b : a), 1);
    const scale = PLOT_SIZE / Math.log1p(peak);
    const bins = Array.from(hist, (count, i) => {
      const x = ((i / (hist.length - 1)) * PLOT_SIZE).toFixed(2);
      const y = (PLOT_SIZE - Math.log1p(count) * scale * 0.88).toFixed(2);
      return `${x} ${y}`;
    });
    return `M 0 ${PLOT_SIZE} L ${bins.join(' L ')} L ${PLOT_SIZE} ${PLOT_SIZE} Z`;
  });

  /** Read one parametric field off the model. */
  const parametricValue = (field: ParametricSlider['field']): number => model()?.[field] ?? 0;

  /** The parametric region sliders have no display-referred equivalent —
   * PV2012's basic-panel curve has no per-region-slider decomposition on
   * the model, only the point curve — so the section hides outside the
   * scene-linear family. */
  const showParametric = computed<boolean>(() => family() === 'sceneLinear');

  return {
    channel,
    family,
    dragOverride,
    activeTab,
    points,
    curvePath,
    knots,
    isIdentity,
    histogramPath,
    parametricValue,
    showParametric,
    tabs,
    familyTabs: FAMILY_TABS,
    sliders: PARAMETRIC_SLIDERS,
    plotSize: PLOT_SIZE,
    parametricMin: PARAMETRIC_RANGE[0],
    parametricMax: PARAMETRIC_RANGE[1],
    /** Grid fractions drawn as faint lines behind the curve. */
    gridLines: [0.25, 0.5, 0.75].map((f) => f * PLOT_SIZE),
  } as const;
}
