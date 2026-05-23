// Plan 3 M2.1 — standalone WebGL2 dev test page.
//
// Loads:
//   - synthetic-input.bin (16x16 fp16 RGBA fixture)
//   - reference.png       (Apple-rendered reference)
// Renders the WebGL2 chain side-by-side with the reference and prints
// mean / P95 / max ΔE₀₀ + per-channel bias.
//
// Hard-required fp16. If the host browser lacks the extensions, the
// page surfaces a banner and refuses to render (M3 adds the
// production fallback).

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  signal,
  AfterViewInit,
} from '@angular/core';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { DecodedSceneLinearImage } from '../../raw-pipeline/raw-pipeline.types';
import { Pipeline, WebglFp16Unsupported } from '../pipeline';
import { computeDeltaEStats } from '../delta-e-2000';

const FIXTURE_INPUT_URL = '/dev-fixtures/synthetic-input.bin';
const FIXTURE_REFERENCE_URL = '/dev-fixtures/reference.png';

// Build the fixture model off the canonical default factory so adding new
// fields to `AdjustmentModel` (e.g. the parametric / tone-curve fields from
// #273) does not silently leave this literal out of date — TS would have
// missed the original incomplete literal too if not for the strict-mode
// `tsc --noEmit` lint sweep.
const FIXTURE_MODEL: AdjustmentModel = {
  ...defaultAdjustmentModel(),
  exposure: 1.0,
  contrast: 25,
  highlights: -30,
  shadows: 40,
  temperature: 5500,
  tint: -10,
  whiteBalancePreset: 'Custom',
  vibrance: 50,
  saturation: -20,
  sharpenAmount: 0,
  sharpenRadius: 0.5,
};

@Component({
  selector: 'maple-webgl-test-page',
  standalone: true,
  templateUrl: './webgl-test-page.component.html',
  styleUrl: './webgl-test-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebglTestPageComponent implements AfterViewInit {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly status = signal<string>('idle');
  readonly meanDeltaE = signal<number | null>(null);
  readonly p95DeltaE = signal<number | null>(null);
  readonly maxDeltaE = signal<number | null>(null);
  readonly biasR = signal<number | null>(null);
  readonly biasG = signal<number | null>(null);
  readonly biasB = signal<number | null>(null);
  readonly errorBanner = signal<string | null>(null);
  readonly referenceUrl = FIXTURE_REFERENCE_URL;

  async ngAfterViewInit(): Promise<void> {
    await this.run();
  }

  private async run(): Promise<void> {
    try {
      this.status.set('loading fixtures');
      const [inputBuf, refImg] = await Promise.all([
        fetch(FIXTURE_INPUT_URL).then((r) => r.arrayBuffer()),
        fetch(FIXTURE_REFERENCE_URL)
          .then((r) => r.blob())
          .then(blobToImageData),
      ]);
      if (inputBuf.byteLength !== 2048) {
        throw new Error(
          `synthetic-input.bin: expected 2048 bytes (16x16 fp16 RGBA), got ${inputBuf.byteLength}`,
        );
      }
      // The Apple side's WhiteBalance kernel falls back to (6500, 0) for
      // the "decoded" WB when `decodedAtModel: nil` (per
      // ImageEditPipeline.processSceneLinear:304-305). Match that so the
      // WB ratio applied here is identical.
      const input: DecodedSceneLinearImage = {
        width: 16,
        height: 16,
        fp16Rgba: new Uint16Array(inputBuf),
        asShotTemperature: 6500,
        asShotTint: 0,
      };

      this.status.set('creating pipeline');
      const pipeline = await Pipeline.create(this.canvasRef.nativeElement);

      this.status.set('rendering');
      const candidate = pipeline.render(input, FIXTURE_MODEL);

      // WebGL renders bottom-up in NDC; the ImageData decoded from a
      // top-down PNG is also top-down. Flip the candidate to match.
      const flipped = flipVerticallyRgba(candidate, 16, 16);
      const stats = computeDeltaEStats(flipped, refImg.data);
      this.meanDeltaE.set(stats.mean);
      this.p95DeltaE.set(stats.p95);
      this.maxDeltaE.set(stats.max);
      this.biasR.set(stats.biasR);
      this.biasG.set(stats.biasG);
      this.biasB.set(stats.biasB);
      this.status.set(`done — ${stats.nPixels} pixels compared`);

      // Don't dispose the pipeline — keep the canvas backbuffer rendered
      // until the user navigates away. M3's production canvas owns its
      // pipeline lifecycle through `ngOnDestroy`.
      void pipeline;
    } catch (err) {
      if (err instanceof WebglFp16Unsupported) {
        this.errorBanner.set(err.message);
      } else {
        this.errorBanner.set((err as Error).message);
      }
      this.status.set('error');
    }
  }
}

async function blobToImageData(blob: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

function flipVerticallyRgba(rgba: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  const rowBytes = w * 4;
  for (let y = 0; y < h; y += 1) {
    const src = y * rowBytes;
    const dst = (h - 1 - y) * rowBytes;
    out.set(rgba.subarray(src, src + rowBytes), dst);
  }
  return out;
}
