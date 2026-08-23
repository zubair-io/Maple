// MuiCanvasSurface — the Maple UI design-system Canvas Surface atom
// (unified-component-catalog.md §1.4; contract:
// docs/design/maple-ui/components/canvas-surface.md). A dumb host for a
// GPU/2D-rendered layer — sizes and letterboxes a `<canvas>` to the given
// content aspect ratio against the `--color-image-canvas` backdrop, and
// hands the raw element to the caller via `canvasReady` once it exists in
// the DOM. All actual drawing is the caller's responsibility; this atom
// owns none of it (unlike `editor-image-canvas`, which is the real
// GPU/2D pipeline host — this is the reusable chrome around one).

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  input,
  output,
} from '@angular/core';

@Component({
  selector: 'mui-canvas-surface',
  standalone: true,
  templateUrl: './mui-canvas-surface.component.html',
  styleUrl: './mui-canvas-surface.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiCanvasSurfaceComponent implements AfterViewInit {
  @ViewChild('canvas') private readonly canvasRef!: ElementRef<HTMLCanvasElement>;

  /** `width / height` of the content the caller will draw — drives the
   * letterbox sizing. `null` fills the host box edge-to-edge. */
  readonly contentAspect = input<number | null>(null);
  /** True before the caller has painted its first frame — shows a loading
   * overlay over the (empty) canvas. */
  readonly loading = input<boolean>(false);

  readonly canvasReady = output<HTMLCanvasElement>();

  ngAfterViewInit(): void {
    this.canvasReady.emit(this.canvasRef.nativeElement);
  }
}
