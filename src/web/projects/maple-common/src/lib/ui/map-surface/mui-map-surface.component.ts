// MuiMapSurface — Maple UI Organisms (Wave W6 Lane B). A reference map
// surface — NOT MapLibre. A pannable token-styled grid backdrop with
// projected pin annotations, simple distance-threshold clustering, and an
// optional density heatmap overlay. Built from Map Annotation, Heatmap
// Layer, Empty State.
//
// Coordinates: each annotation's `x`/`y` are already-normalized 0..1
// values (the caller's projection, whatever it is — lng/lat or otherwise —
// has already been mapped into that range). This component only turns that
// into screen pixels: `screenX = x * viewportWidth + panX`.
//
// Panning reuses the shared pointer-capture drag guards from
// ../internal/pointer-drag.ts (the same convention as mui-color-wheel/
// mui-pad-2d/mui-drag-bar/mui-living-slider) rather than re-deriving the
// "is this pointermove still the drag I started" check.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiHeatmapLayerComponent } from '../heatmap-layer/mui-heatmap-layer.component';
import { MuiMapAnnotationComponent } from '../map-annotation/mui-map-annotation.component';
import { isPointerDragEnd, isPointerDragMove } from '../internal/pointer-drag';

export interface MuiMapAnnotationInput {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly label?: string | null;
  readonly thumbnailUrl?: string | null;
}

export interface MuiMapPanOffset {
  readonly x: number;
  readonly y: number;
}

interface MuiMapPin {
  readonly id: string;
  readonly screenX: number;
  readonly screenY: number;
  readonly label: string | null;
  readonly thumbnailUrl: string | null;
  readonly count: number | null;
  readonly memberIds: readonly string[];
}

interface MuiDragOrigin {
  readonly startX: number;
  readonly startY: number;
  readonly panX: number;
  readonly panY: number;
}

/** A positioned annotation, pre-clustering: the caller's annotation fields
 * plus its screen-space position. */
type MuiPositionedAnnotation = MuiMapAnnotationInput & {
  readonly screenX: number;
  readonly screenY: number;
};

const HEATMAP_ROWS = 8;
const HEATMAP_COLS = 8;

/** Greedy distance-threshold grouping: walk the positioned annotations in
 * order, and fold every not-yet-claimed annotation within `threshold` px of
 * the current one into its cluster. Simple and deterministic given a stable
 * input order — not a proper spatial index, which this reference surface
 * doesn't need. Split out from `clusters` (with {@link toClusterPin}) so
 * neither function nests a distance check inside a double loop inside a
 * ternary-laden pin-building step all at once. */
function groupByDistance(
  positioned: readonly MuiPositionedAnnotation[],
  threshold: number,
): readonly (readonly MuiPositionedAnnotation[])[] {
  const claimed = new Set<string>();
  const groups: MuiPositionedAnnotation[][] = [];

  for (const anchor of positioned) {
    if (claimed.has(anchor.id)) continue;
    const group = [anchor];
    claimed.add(anchor.id);

    for (const candidate of positioned) {
      if (claimed.has(candidate.id)) continue;
      const dx = anchor.screenX - candidate.screenX;
      const dy = anchor.screenY - candidate.screenY;
      if (Math.sqrt(dx * dx + dy * dy) <= threshold) {
        group.push(candidate);
        claimed.add(candidate.id);
      }
    }

    groups.push(group);
  }

  return groups;
}

/** Reduces one cluster group to its rendered pin: the group's screen-space
 * centroid, plus a single member's label/thumbnail only when the group
 * wasn't merged with anything else (a merged cluster shows its `count`
 * instead). */
function toClusterPin(group: readonly MuiPositionedAnnotation[]): MuiMapPin {
  const anchor = group[0];
  const screenX = group.reduce((sum, member) => sum + member.screenX, 0) / group.length;
  const screenY = group.reduce((sum, member) => sum + member.screenY, 0) / group.length;
  const merged = group.length > 1;
  return {
    id: anchor.id,
    screenX,
    screenY,
    label: merged ? null : (anchor.label ?? null),
    thumbnailUrl: merged ? null : (anchor.thumbnailUrl ?? null),
    count: merged ? group.length : null,
    memberIds: group.map((member) => member.id),
  };
}

@Component({
  selector: 'mui-map-surface',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiEmptyStateComponent,
    MuiHeatmapLayerComponent,
    MuiMapAnnotationComponent,
  ],
  templateUrl: './mui-map-surface.component.html',
  styleUrl: './mui-map-surface.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiMapSurfaceComponent {
  readonly annotations = input.required<readonly MuiMapAnnotationInput[]>();
  readonly heatmapVisible = model<boolean>(false);
  readonly viewportWidth = input<number>(640);
  readonly viewportHeight = input<number>(400);
  /** Screen-pixel distance under which two pins are merged into one
   * cluster. */
  readonly clusterThreshold = input<number>(40);

  readonly panChanged = output<MuiMapPanOffset>();
  readonly annotationSelected = output<string>();
  readonly heatmapToggled = output<boolean>();

  readonly pan = signal<MuiMapPanOffset>({ x: 0, y: 0 });
  private readonly activePointerId = signal<number | null>(null);
  private readonly dragOrigin = signal<MuiDragOrigin | null>(null);

  private readonly positioned = computed(() =>
    this.annotations().map((annotation) => ({
      ...annotation,
      screenX: annotation.x * this.viewportWidth() + this.pan().x,
      screenY: annotation.y * this.viewportHeight() + this.pan().y,
    })),
  );

  /** Distance-threshold clustering of the positioned annotations — the
   * grouping and per-group pin math live in {@link groupByDistance} and
   * {@link toClusterPin}, so this stays a plain pipeline. */
  readonly clusters = computed<readonly MuiMapPin[]>(() =>
    groupByDistance(this.positioned(), this.clusterThreshold()).map(toClusterPin),
  );

  /** Density grid for the heatmap overlay — built from the raw normalized
   * coordinates (not pan-adjusted screen space), since the heatmap
   * represents the underlying data's density, not the current viewport. */
  readonly heatmapGrid = computed<readonly (readonly number[])[]>(() => {
    const grid: number[][] = Array.from({ length: HEATMAP_ROWS }, () =>
      new Array(HEATMAP_COLS).fill(0),
    );
    for (const annotation of this.annotations()) {
      const col = Math.min(HEATMAP_COLS - 1, Math.max(0, Math.floor(annotation.x * HEATMAP_COLS)));
      const row = Math.min(HEATMAP_ROWS - 1, Math.max(0, Math.floor(annotation.y * HEATMAP_ROWS)));
      grid[row][col] += 1;
    }
    const max = Math.max(1, ...grid.flat());
    return grid.map((row) => row.map((value) => value / max));
  });

  onPointerDown(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.activePointerId.set(event.pointerId);
    const current = this.pan();
    this.dragOrigin.set({
      startX: event.clientX,
      startY: event.clientY,
      panX: current.x,
      panY: current.y,
    });
  }

  onPointerMove(event: PointerEvent): void {
    const origin = this.dragOrigin();
    if (!isPointerDragMove(origin !== null, event, this.activePointerId())) return;
    if (!origin) return;
    const next = {
      x: origin.panX + (event.clientX - origin.startX),
      y: origin.panY + (event.clientY - origin.startY),
    };
    this.pan.set(next);
    this.panChanged.emit(next);
  }

  onPointerUp(event: PointerEvent): void {
    if (!isPointerDragEnd(event, this.activePointerId())) return;
    this.activePointerId.set(null);
    this.dragOrigin.set(null);
  }

  selectPin(pin: MuiMapPin): void {
    this.annotationSelected.emit(pin.memberIds[0]);
  }

  toggleHeatmap(): void {
    const next = !this.heatmapVisible();
    this.heatmapVisible.set(next);
    this.heatmapToggled.emit(next);
  }
}
