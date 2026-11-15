import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import type {
  PanoPreviewResult,
  SeamConstraintsRequest,
  SeamConstraintRegion,
} from '../../api/pano.service';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';
import { MuiInputComponent } from '../../ui/input/mui-input.component';
import { MuiSelectComponent } from '../../ui/select/mui-select.component';
import {
  seamDragRect,
  seamPoint,
  validSeamRect,
  type SeamCanvas,
  type SeamPoint,
  type SeamRect,
} from '../pano-seam-geometry';

interface SeamDrag {
  pointerId: number;
  start: SeamPoint;
  end: SeamPoint;
  frame: number;
  kind: SeamConstraintRegion['kind'];
}

let nextSeamEditorId = 0;

@Component({
  selector: 'app-pano-seam-editor',
  standalone: true,
  imports: [MuiButtonComponent, MuiInputComponent, MuiSelectComponent],
  templateUrl: './pano-seam-editor.component.html',
  styleUrl: './pano-seam-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PanoSeamEditorComponent {
  readonly imageUrl = input.required<string>();
  readonly reasonId = `pano-seam-disabled-${nextSeamEditorId++}`;
  readonly previewCanvas = input.required<SeamCanvas>();
  readonly frames = input.required<NonNullable<PanoPreviewResult['frames']>>();
  readonly disabledReason = input<string | null>(null);
  readonly readOnly = input(false);
  readonly constraints = model<SeamConstraintsRequest | null>(null);
  readonly previewRequested = output<void>();
  readonly frame = signal('0');
  readonly kind = signal<SeamConstraintRegion['kind']>('include');
  readonly x = signal('0');
  readonly y = signal('0');
  readonly width = signal('1');
  readonly height = signal('1');
  readonly error = signal<string | null>(null);
  readonly drag = signal<SeamDrag | null>(null);
  readonly modeOptions = [
    { value: 'include', label: 'Include — use this frame' },
    { value: 'exclude', label: 'Exclude — avoid this frame' },
  ];
  readonly frameOptions = computed(() =>
    this.frames().map((frame, index) => ({
      value: String(index),
      label: `${index + 1}: ${frame.path}`,
    })),
  );
  readonly canvas = computed(() => this.constraints()?.canvas ?? this.previewCanvas());
  readonly regions = computed(() => this.constraints()?.regions ?? []);
  readonly disabled = computed(() => this.readOnly() || this.disabledReason() !== null);
  readonly aspect = computed(() => this.previewCanvas().width / this.previewCanvas().height);
  readonly frameWidth = computed(() => `min(100%, calc(min(240px, 26vh) * ${this.aspect()}))`);
  readonly draft = computed(() => {
    const drag = this.drag();
    return drag ? seamDragRect(drag.start, drag.end, this.canvas()) : null;
  });

  constructor() {
    effect(() => {
      if (this.disabled()) this.drag.set(null);
    });
  }

  setKind(value: string): void {
    if (value === 'include' || value === 'exclude') this.kind.set(value);
  }

  onNumericEnter(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.addNumeric();
  }

  addNumeric(): void {
    const values = [this.x(), this.y(), this.width(), this.height()];
    if (values.some((value) => value.trim() === '')) {
      this.error.set('Enter X, Y, width and height in preview pixels.');
      return;
    }
    this.add({
      x: Number(this.x()),
      y: Number(this.y()),
      width: Number(this.width()),
      height: Number(this.height()),
    });
  }

  private add(rect: SeamRect, frame = Number(this.frame()), kind = this.kind()): void {
    if (this.disabled()) return;
    if (!validSeamRect(rect, this.canvas()) || !Number.isInteger(frame) || !this.frames()[frame]) {
      this.error.set(
        'Choose a frame and a positive whole-pixel rectangle wholly inside the preview canvas.',
      );
      return;
    }
    this.constraints.set({
      version: 1,
      canvas: this.canvas(),
      regions: [...this.regions(), { kind, frame, ...rect }],
    });
    this.error.set(null);
  }

  remove(index: number): void {
    if (this.readOnly()) return;
    const regions = this.regions().filter((_, i) => i !== index);
    this.constraints.set(regions.length ? { version: 1, canvas: this.canvas(), regions } : null);
  }

  clear(): void {
    if (!this.readOnly()) this.constraints.set(null);
  }

  pointerDown(event: PointerEvent): void {
    if (this.disabled() || event.button !== 0 || this.drag()) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const start = seamPoint(
      { x: event.clientX, y: event.clientY },
      target.getBoundingClientRect(),
      this.canvas(),
    );
    if (!start) return;
    event.preventDefault();
    target.setPointerCapture(event.pointerId);
    this.drag.set({
      pointerId: event.pointerId,
      start,
      end: start,
      frame: Number(this.frame()),
      kind: this.kind(),
    });
  }

  pointerMove(event: PointerEvent): void {
    const drag = this.drag();
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const end = seamPoint(
      { x: event.clientX, y: event.clientY },
      target.getBoundingClientRect(),
      this.canvas(),
    );
    if (end) this.drag.set({ ...drag, end });
  }

  pointerUp(event: PointerEvent): void {
    this.pointerMove(event);
    const drag = this.drag();
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = this.draft();
    this.drag.set(null);
    if (rect) this.add(rect, drag.frame, drag.kind);
  }

  cancelDrag(): void {
    this.drag.set(null);
  }
}
