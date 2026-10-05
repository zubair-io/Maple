// mask-session.service.ts — the mask-editing session (#1541).
//
// `active` is derived from the editor's armed tool, so the overlay shows and
// the panel swaps in exactly while the Mask dock entry is armed — the same
// derivation `CropSessionService` uses. The selected-layer index is transient
// UI state (never persisted); the layers themselves are
// `AdjustmentModel.localAdjustments`, so undo/redo, the debounced sidecar
// write and the live render all follow from `LibraryStateService.
// updateAdjustment` — one source of truth, the same rule every other tool
// obeys. The render needs no host change: the canvas hands raw-core the
// serialized sidecar, which now carries the containers (#358), and the
// 19-scalar fast path already routes a non-empty stack to the full path.
//
// Undo boundaries: a DISCRETE edit (add, remove, invert, reset) commits its
// own snapshot; a CONTINUOUS one (a slider or a canvas-handle drag) opens a
// gesture with `beginGesture()` — which commits once, idempotently — and
// closes it with `endGesture()` on release, mirroring the Apple
// `EditorState+Masks` API.

import { Injectable, computed, effect, inject, linkedSignal, signal } from '@angular/core';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import {
  SubjectMaskError,
  SubjectMaskService,
  bitmapDigestsIn,
} from '../../masks/subject-mask.service';
import { subjectMaskDigest } from '../../masks/subject-mask-digest';
import type {
  LocalAdjustment,
  LocalMask,
  LeafMask,
  MaskCombine,
  MaskComponent,
  PartialAdjustments,
  RangeRefinement,
} from '../../models/local-adjustment';
import type { MaskRangeSeed } from '../../raw-pipeline/raw-pipeline.sample-range.types';
import { defaultLinearMask, defaultRadialMask, withMaskFeather } from './mask-geometry';
import { removeAt } from '../../editor/list-selection';
import { defaultRangeRefinement, withRangeField, type RangeFieldId } from './mask-range';
import { sampleMaskRangeInto, seededLayer } from './mask-range-sample';

/** Structural equality for one layer — the model is plain data. */
const isSameLayer = (a: LocalAdjustment, b: LocalAdjustment): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

@Injectable({ providedIn: 'root' })
export class MaskSessionService {
  private readonly editor = inject(EditorStateService);
  private readonly library = inject(LibraryStateService);
  private readonly pipeline = inject(RawPipelineService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly subjects = inject(SubjectMaskService);

  /** True while the Mask tool is armed — drives the overlay + panel. */
  readonly active = computed(() => this.editor.armedTool() === 'mask');

  /** Index of the selected layer, or null. Re-validated by `selected`. */
  readonly selectedIndex = signal<number | null>(null);

  readonly layers = computed<readonly LocalAdjustment[]>(() => {
    const a = this.library.focusedAsset();
    return a ? this.library.adjustmentFor(a.id)().localAdjustments : [];
  });

  readonly selected = computed<LocalAdjustment | null>(() => {
    const index = this.selectedIndex();
    const layers = this.layers();
    return index !== null && index >= 0 && index < layers.length ? layers[index] : null;
  });

  private readonly componentSelection = linkedSignal({
    source: () => `${this.library.focusedAsset()?.id}:${this.selectedIndex()}`,
    computation: () => 0,
  });
  readonly componentIndex = computed(() => {
    const mask = this.selected()?.mask;
    return mask?.kind === 'group'
      ? Math.max(0, Math.min(this.componentSelection(), mask.components.length - 1))
      : 0;
  });
  readonly selectedMask = computed<LeafMask | null>(() => {
    const mask = this.selected()?.mask;
    return mask?.kind === 'group'
      ? (mask.components[this.componentIndex()]?.mask ?? null)
      : (mask ?? null);
  });

  selectComponent(index: number): void {
    this.endGesture();
    const mask = this.selected()?.mask;
    if (mask?.kind === 'group' && index >= 0 && index < mask.components.length)
      this.componentSelection.set(index);
  }

  addComponent(kind: 'linear' | 'radial', combine: MaskCombine): void {
    const selected = this.selected();
    if (!selected) return;
    const asset = this.library.focusedAsset();
    const aspect = asset?.width && asset?.height ? asset.width / asset.height : 1;
    const mask = kind === 'linear' ? defaultLinearMask() : defaultRadialMask(aspect);
    const index = selected.mask.kind === 'group' ? selected.mask.components.length : 1;
    this.updateSelected(true, (layer) => {
      const group =
        layer.mask.kind === 'group'
          ? layer.mask
          : {
              kind: 'group' as const,
              components: [{ mask: layer.mask, combine: 'add' as const, invert: false }],
              opacity: 1,
              invert: false,
            };
      return {
        ...layer,
        mask: { ...group, components: [...group.components, { mask, combine, invert: false }] },
      };
    });
    this.componentSelection.set(index);
  }

  removeComponent(index: number): void {
    const mask = this.selected()?.mask;
    if (
      mask?.kind !== 'group' ||
      mask.components.length <= 1 ||
      index < 0 ||
      index >= mask.components.length
    )
      return;
    const selected = this.componentIndex();
    const removed = mask.components[index];
    this.updateSelected(true, (layer) =>
      layer.mask.kind === 'group' &&
      layer.mask.components.length > 1 &&
      index >= 0 &&
      index < layer.mask.components.length
        ? {
            ...layer,
            mask: {
              ...layer.mask,
              components: layer.mask.components.filter((_, i) => i !== index),
            },
          }
        : layer,
    );
    this.componentSelection.set(
      Math.min(index < selected ? selected - 1 : selected, this.componentIndex()),
    );
    if (removed) {
      const ghost: LocalAdjustment = {
        mask: removed.mask,
        adjustments: {},
      };
      this.subjects.releaseDigests(bitmapDigestsIn([ghost]), this.layers());
    }
  }

  setComponentCombine(combine: MaskCombine): void {
    this.updateSelectedComponent((component) => ({ ...component, combine }));
  }

  setComponentInverted(invert: boolean): void {
    this.updateSelectedComponent((component) => ({ ...component, invert }));
  }

  private updateSelectedComponent(update: (component: MaskComponent) => MaskComponent): void {
    const index = this.componentIndex();
    this.updateSelected(true, (layer) =>
      layer.mask.kind === 'group'
        ? {
            ...layer,
            mask: {
              ...layer.mask,
              components: layer.mask.components.map((component, i) =>
                i === index ? update(component) : component,
              ),
            },
          }
        : layer,
    );
  }

  setOpacity(opacity: number): void {
    if (!Number.isFinite(opacity)) return;
    const clamped = Math.min(1, Math.max(0, opacity));
    this.updateSelected(false, (layer) => {
      if (layer.mask.kind !== 'group' && clamped === 1) return layer;
      const mask =
        layer.mask.kind === 'group'
          ? layer.mask
          : {
              kind: 'group' as const,
              components: [{ mask: layer.mask, combine: 'add' as const, invert: false }],
              opacity: 1,
              invert: false,
            };
      return { ...layer, mask: { ...mask, opacity: clamped } };
    });
  }

  setGroupInverted(invert: boolean): void {
    this.updateSelected(true, (layer) =>
      layer.mask.kind === 'group' ? { ...layer, mask: { ...layer.mask, invert } } : layer,
    );
  }

  private gestureOpen = false;

  constructor() {
    // Arming the tool with nothing valid selected lands on the first layer,
    // so the panel never opens on "nothing" when layers exist.
    effect(() => {
      if (!this.active()) {
        // Disarming mid-drag unmounts the overlay before its pointerup —
        // close the gesture so the next drag opens a fresh undo boundary.
        this.endGesture();
        return;
      }
      if (this.selected() === null && this.layers().length > 0) this.selectedIndex.set(0);
    });
    // Re-register a loaded sidecar's bitmap rasters (Apple's
    // `rehydratedMaskRasters`, #3300): the registry is per-process and
    // `rasterId` never persists, so without this a saved person mask would
    // reopen at weight 0. Memoized inside the service — a no-op once every
    // digest is registered — and digest-keyed, so no asset guard is needed.
    effect(() => {
      const layers = this.layers();
      if (layers.length === 0) return;
      void this.subjects.ensureBitmapRasters(layers);
    });
  }

  select(index: number | null): void {
    this.endGesture();
    const valid = index !== null && index >= 0 && index < this.layers().length;
    this.selectedIndex.set(valid ? index : null);
  }

  /** Append a layer carrying `mask` and no adjustments, select it, return its index. */
  add(mask: LocalMask): number {
    return this.addLayers([{ mask, adjustments: {} }]);
  }

  /** Append full layers (mask + range + adjustments) as ONE undo entry and
   *  select the first of them — the detect path's commit. */
  addLayers(layers: LocalAdjustment[]): number {
    this.endGesture();
    this.editor.commit();
    const next = [...this.layers(), ...layers];
    this.write(next);
    const first = next.length - layers.length;
    this.selectedIndex.set(first);
    return first;
  }

  addLinear(): number {
    return this.add(defaultLinearMask());
  }

  addRadial(): number {
    const a = this.library.focusedAsset();
    const aspect = a?.width && a?.height ? a.width / a.height : 1;
    return this.add(defaultRadialMask(aspect));
  }

  remove(index: number): void {
    const layers = this.layers();
    const removal = removeAt(layers, index);
    if (!removal) return;
    this.endGesture();
    this.editor.commit();
    this.write(removal.next);
    this.selectedIndex.set(removal.selected);
    const removed = layers[index];
    if (removed) this.subjects.releaseDigests(bitmapDigestsIn([removed]), removal.next);
  }

  removeSelected(): void {
    const index = this.selectedIndex();
    if (index !== null) this.remove(index);
  }

  // ── Subject masks (#3300) ──────────────────────────────────────────────────

  /** True while a detect is in flight — the panel shows the button loading. */
  readonly detectInFlight = signal(false);

  /** Why the last detect produced no person layers; cleared by the next run. */
  readonly detectMessage = signal<string | null>(null);

  /**
   * Detect the frame's people and add one skin layer per new person
   * (bitmap + the skin-tone range, Apple's `createPersonSkinMask` shape),
   * as ONE undo entry. Nobody detected → a whole-image skin range instead
   * (Apple's `createWholeImageSkinMask`); a failed detect adds nothing.
   */
  async detectSubjects(): Promise<void> {
    const asset = this.library.focusedAsset();
    if (!asset || this.detectInFlight()) return;
    this.detectInFlight.set(true);
    this.detectMessage.set(null);
    try {
      const detection = await this.subjects.detect(asset.id);
      if (detection.persons.length === 0) {
        this.addLayers([
          { mask: { kind: 'everywhere' }, range: defaultRangeRefinement(), adjustments: {} },
        ]);
        this.detectMessage.set('No people detected — added a whole-image skin range instead.');
        return;
      }
      const known = new Set(bitmapDigestsIn(this.layers()));
      const fresh = detection.persons.filter(
        (candidate) =>
          !known.has(subjectMaskDigest(asset.id, candidate.person, true, true, detection.model)),
      );
      if (fresh.length === 0) {
        this.detectMessage.set('Every detected person already has a mask.');
        return;
      }
      const layers: LocalAdjustment[] = [];
      try {
        for (const candidate of fresh) {
          const recipe = {
            person: candidate.person,
            facialSkin: true,
            bodySkin: true,
            model: detection.model,
            digest: subjectMaskDigest(asset.id, candidate.person, true, true, detection.model),
          };
          const rasterId = await this.subjects.ensureRaster(recipe);
          layers.push({
            mask: { kind: 'bitmap', recipe, rasterId },
            range: defaultRangeRefinement(),
            adjustments: {},
          });
        }
      } catch (err) {
        // All-or-nothing: rasters registered for layers that will never be
        // added are released (unless a remaining layer names them).
        this.subjects.releaseDigests(bitmapDigestsIn(layers), this.layers());
        throw err;
      }
      this.addLayers(layers);
    } catch (err) {
      this.detectMessage.set(
        err instanceof SubjectMaskError
          ? err.message
          : `Subject detection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.detectInFlight.set(false);
    }
  }

  /** Open a continuous gesture: commits ONE undo snapshot per gesture. */
  beginGesture(): void {
    if (this.gestureOpen) return;
    this.editor.commit();
    this.gestureOpen = true;
  }

  endGesture(): void {
    this.gestureOpen = false;
  }

  /** Rewrite the selected layer. `discrete` edits commit their own entry;
   *  continuous ones ride the open gesture (opening it if needed). */
  updateSelected(discrete: boolean, transform: (layer: LocalAdjustment) => LocalAdjustment): void {
    const index = this.selectedIndex();
    const layers = this.layers();
    if (index === null || index < 0 || index >= layers.length) return;
    // Decide whether anything changes BEFORE touching the undo stack, so a
    // no-op (invert on a linear layer, a redundant write) pushes nothing.
    const next = transform(layers[index]);
    if (next === layers[index] || isSameLayer(next, layers[index])) return;
    if (discrete) {
      this.endGesture();
      this.editor.commit();
    } else {
      this.beginGesture();
    }
    this.write(layers.map((layer, i) => (i === index ? next : layer)));
  }

  setShape(mask: LocalMask): void {
    const index = this.componentIndex();
    this.updateSelected(false, (layer) =>
      layer.mask.kind === 'group' && mask.kind !== 'group'
        ? {
            ...layer,
            mask: {
              ...layer.mask,
              components: layer.mask.components.map((component, i) =>
                i === index ? { ...component, mask } : component,
              ),
            },
          }
        : { ...layer, mask },
    );
  }

  /** The selected layer's value for `field`, `0` when unset. */
  adjustment(field: keyof PartialAdjustments): number {
    return this.selected()?.adjustments[field] ?? 0;
  }

  setAdjustment(field: keyof PartialAdjustments, value: number): void {
    this.updateSelected(false, (layer) => ({
      ...layer,
      adjustments: { ...layer.adjustments, [field]: value },
    }));
  }

  resetAdjustments(): void {
    this.updateSelected(true, (layer) => ({ ...layer, adjustments: {} }));
  }

  setFeather(feather: number): void {
    const mask = this.selectedMask();
    if (mask) this.setShape(withMaskFeather(mask, feather));
  }

  /** Flip a radial layer's sense; no-op for a linear layer. */
  setInverted(invert: boolean): void {
    this.updateSelected(true, (layer) =>
      layer.mask.kind === 'radial' ? { ...layer, mask: { ...layer.mask, invert } } : layer,
    );
  }

  // ── Colour range (#362) ──────────────────────────────────────────────────

  /** The selected layer's colour-range refinement, or null for none. */
  readonly range = computed<RangeRefinement | null>(() => this.selected()?.range ?? null);

  /** Why the last eyedropper pick was refused; cleared by the next arm. */
  readonly rangeMessage = signal<string | null>(null);

  /** True while a pick is in flight — the panel disables its eyedropper. */
  readonly rangeSampleInFlight = signal(false);

  /** Arm raw-core's default range, or drop the refinement entirely (the
   *  primary mask alone). Discrete: its own undo entry. */
  setRangeEnabled(enabled: boolean): void {
    this.updateSelected(true, (layer) => ({
      ...layer,
      range: enabled ? (layer.range ?? defaultRangeRefinement()) : undefined,
    }));
  }

  /** The selected layer's value for one range slider, `0` when it has no
   *  refinement (the sliders are unmounted then). */
  rangeValue(field: RangeFieldId): number {
    return this.range()?.[field] ?? 0;
  }

  /** Continuous: rides the drag's gesture, like every other mask slider. */
  setRangeField(field: RangeFieldId, value: number): void {
    this.updateSelected(false, (layer) =>
      layer.range ? { ...layer, range: withRangeField(layer.range, field, value) } : layer,
    );
  }

  /**
   * Sample the colour at a normalised image point and seed the selected
   * layer's range with it, as ONE undo entry. A layer with no refinement is
   * enabled by the pick itself.
   */
  async sampleRangeAt(nx: number, ny: number): Promise<boolean> {
    if (this.rangeSampleInFlight() || this.selected() === null) return false;
    this.rangeSampleInFlight.set(true);
    try {
      return await sampleMaskRangeInto(this.rangeSampleHost(), nx, ny);
    } finally {
      this.rangeSampleInFlight.set(false);
    }
  }

  /** The structural host `sampleMaskRangeInto` writes through. */
  private rangeSampleHost() {
    return {
      focusedAssetId: () => this.library.focusedAsset()?.id ?? null,
      currentAdjustment: (id: string) => this.library.adjustmentFor(id)(),
      assetExtension: (id: string) =>
        this.library
          .assets()
          .find((a) => a.id === id)
          ?.filename.split('.')
          .pop()
          ?.toLowerCase() ?? 'dng',
      bytes: async (id: string) =>
        this.library.bytesFor(id) ?? (await this.library.bytesForAsset(id)),
      serialize: (model: Parameters<XmpSerializerService['serialize']>[0]) =>
        this.serializer.serialize(model),
      sampleMaskRange: (
        bytes: Uint8Array,
        ext: string,
        xmp: string,
        nx: number,
        ny: number,
      ): Promise<MaskRangeSeed> => this.pipeline.sampleMaskRange(bytes, ext, xmp, nx, ny),
      applySeed: (seed: MaskRangeSeed) =>
        this.updateSelected(true, (layer) => seededLayer(layer, seed)),
      setMessage: (text: string | null) => this.rangeMessage.set(text),
    };
  }

  private write(localAdjustments: LocalAdjustment[]): void {
    const a = this.library.focusedAsset();
    if (!a) return;
    this.library.updateAdjustment(a.id, { localAdjustments });
  }
}
