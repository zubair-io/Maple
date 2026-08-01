// crop-toolbar.component.ts — controls for the crop tool (#638).
//
// Shown in the editor's control stack (in place of the drag bar) while the Crop
// pill is armed: aspect-ratio presets, a straighten dial, and reset / done.
// The interactive crop rectangle itself lives in `CropOverlayComponent` over
// the canvas; this is the value/affordance strip beside it.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { LibraryStateService } from '../state/library-state.service';
import { EditorStateService } from './editor-state.service';
import { CropSessionService } from '../components/crop-overlay/crop-session.service';
import { ImageCanvasService } from '../components/image-canvas/image-canvas.service';
import {
  ASPECT_PRESETS,
  type AspectId,
  resolveAspect,
} from '../components/crop-overlay/crop-aspect';
import { centeredCropForAspect } from '../components/crop-overlay/crop-geometry';
import { defaultCrop, isIdentityCrop } from '../models/adjustment-model';

/** Straighten range in degrees (matches the reference renderer's ±45 band). */
const STRAIGHTEN_MIN = -45;
const STRAIGHTEN_MAX = 45;

@Component({
  selector: 'app-crop-toolbar',
  standalone: true,
  templateUrl: './crop-toolbar.component.html',
  styleUrl: './crop-toolbar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CropToolbarComponent {
  private readonly library = inject(LibraryStateService);
  private readonly editor = inject(EditorStateService);
  private readonly canvas = inject(ImageCanvasService);
  protected readonly crop = inject(CropSessionService);

  protected readonly presets = ASPECT_PRESETS;
  protected readonly straightenMin = STRAIGHTEN_MIN;
  protected readonly straightenMax = STRAIGHTEN_MAX;

  private readonly model = computed(() => {
    const id = this.editor.imageId();
    return id ? this.library.adjustmentFor(id)() : null;
  });

  protected readonly angle = computed(() => this.model()?.crop.angle ?? 0);
  protected readonly angleLabel = computed(() => `${this.angle().toFixed(1)}°`);
  protected readonly canReset = computed(() => {
    const m = this.model();
    return m ? !isIdentityCrop(m.crop) : false;
  });

  protected readonly activeAspect = computed<AspectId>(() => this.crop.aspectId());
  protected readonly imageDimensions = computed(() => {
    const asset = this.library.focusedAsset();
    const native = this.canvas.nativeDimensions();
    const width = positiveDimension(asset?.width, native?.w);
    const height = positiveDimension(asset?.height, native?.h);
    return width && height ? { width, height } : null;
  });

  protected aspectDisabled(id: AspectId): boolean {
    return id !== 'free' && this.imageDimensions() === null;
  }

  /** Select an aspect-ratio preset. `free` only unlocks; a fixed ratio snaps
   *  the crop to a centered rect of that ratio (preserving the angle). */
  protected selectAspect(id: AspectId): void {
    if (id === 'free') {
      this.crop.setAspect(id);
      return;
    }
    const id2 = this.editor.imageId();
    const a = this.library.focusedAsset();
    const m = this.model();
    if (!id2 || !a || !m) return;
    const dimensions = this.imageDimensions();
    if (!dimensions) return;
    const { width, height } = dimensions;
    this.crop.setAspect(id);
    const ratio = resolveAspect(this.crop.aspectPreset(), width, height);
    if (ratio == null) return;
    this.editor.commit();
    this.library.updateAdjustment(id2, {
      crop: centeredCropForAspect(ratio, width, height, m.crop.angle),
    });
  }

  /** Commit one undo snapshot at the start of a straighten drag. */
  protected onStraightenStart(): void {
    this.editor.commit();
  }

  protected onStraighten(value: string): void {
    const id = this.editor.imageId();
    const m = this.model();
    if (!id || !m) return;
    const angle = clamp(Number(value), STRAIGHTEN_MIN, STRAIGHTEN_MAX);
    this.library.updateAdjustment(id, { crop: { ...m.crop, angle } });
  }

  protected reset(): void {
    const id = this.editor.imageId();
    if (!id || !this.canReset()) return;
    this.editor.commit();
    this.library.updateAdjustment(id, { crop: defaultCrop() });
    this.crop.setAspect('free');
  }

  /** Exit crop — re-arm Exposure so the canvas renders the cropped result. */
  protected done(): void {
    this.editor.armTool('exposure');
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function positiveDimension(primary?: number, fallback?: number): number | undefined {
  return primary != null && primary > 0 ? primary : fallback;
}
