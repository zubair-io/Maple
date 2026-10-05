// subject-mask.service.ts — the web detection source (#3300 slice 3).
//
// DECISION (slice 3): server-side segmentation. The render worker's raster
// registry (slice 2) takes an R8 raster + the 16-hex digest the `BitmapRecipe`
// carries; this service is what produces them on web: person candidates come
// from the Self-Hosted server's segmentation stage
// (`GET /api/subject-masks/persons`), rasters by digest from its cache
// (`GET /api/subject-masks/raster/<digest>`), mirrored into IndexedDB. An
// in-browser model was rejected for M3 — `docs/strategy/milestones/
// m3-local-adjustments.md` §7 excludes web AI-model integration ("scope once
// #1472 Phase 2 proves the pattern on Apple"), and a multi-MB download plus
// per-device inference cost is the wrong trade while the server can segment
// once per asset for every browser. The server stage + endpoints are a
// follow-up issue; this client defines the wire contract they implement.
//
// Mirrors Apple's `EditSession+Masks` flow (detect → raster → register →
// layer) with the server standing in for Vision: digests use the identical
// FNV-1a scheme (`subject-mask-digest.ts`), the IndexedDB cache mirrors
// `MaskRasterStore`'s `<digest>.png` files, and rehydration re-registers a
// loaded sidecar's bitmap layers without touching the store model —
// `rasterId` is never persisted, and a silent store patch would dirty the
// sidecar mtime and churn every mtime-keyed cache (`docs/caching.md`). The
// live digest→id table lives here instead; the render resolves by digest
// anyway (raw-wasm `resolve_into`'s digest fallback).

import { Injectable, Injector, inject } from '@angular/core';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import type {
  BitmapRecipe,
  LeafMask,
  LocalAdjustment,
  LocalMask,
} from '../models/local-adjustment';
import { SUBJECT_MASK_CACHE, type SubjectMaskRasterCache } from './subject-mask-cache';
import { SUBJECT_MASK_PNG_DECODER } from './subject-mask-png';
import {
  detectServerSubjectMasks,
  fetchServerSubjectMaskRasterBytes,
} from './subject-mask-server-bridge';
import type { SubjectMaskDetection } from './subject-mask-server.service';

/** Why a detect or raster resolve failed — the panel maps these to UI copy. */
export type SubjectMaskFailureKind = 'unsupported' | 'unavailable' | 'failed';

export class SubjectMaskError extends Error {
  readonly kind: SubjectMaskFailureKind;

  constructor(kind: SubjectMaskFailureKind, message: string) {
    super(message);
    this.name = 'SubjectMaskError';
    this.kind = kind;
  }
}

const isHttpStatus = (err: unknown, status: number): boolean =>
  typeof err === 'object' && err !== null && (err as { status?: unknown }).status === status;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Every bitmap digest `layers` names — top-level leaves and group components. */
export function bitmapDigestsIn(layers: readonly LocalAdjustment[]): string[] {
  const digests: string[] = [];
  const visit = (mask: LocalMask): void => {
    if (mask.kind === 'group') {
      for (const component of mask.components) visit(component.mask);
      return;
    }
    const leaf: LeafMask = mask;
    if (leaf.kind === 'bitmap') digests.push(leaf.recipe.digest);
  };
  for (const layer of layers) visit(layer.mask);
  return [...new Set(digests)];
}

@Injectable({ providedIn: 'root' })
export class SubjectMaskService {
  private readonly backend = inject(LIBRARY_BACKEND);
  private readonly injector = inject(Injector);
  private readonly pipeline = inject(RawPipelineService);
  private readonly cache = inject(SUBJECT_MASK_CACHE);
  private readonly decode = inject(SUBJECT_MASK_PNG_DECODER);

  /** Live digest→registry-id table. Ids die with the worker, so each entry
   *  is pinned to the `workerEpoch` it was registered under. */
  private readonly registered = new Map<string, { id: number; epoch: number }>();
  /** One resolution per digest — concurrent misses share the fetch+register. */
  private readonly inFlight = new Map<string, Promise<number>>();

  /**
   * Who is in the frame. Throws `unsupported` on Hosted (no server to ask),
   * `unavailable` when the server has no segmentation for this asset (404),
   * `failed` for anything else. An empty `persons` is a successful "nobody".
   */
  async detect(assetKey: string): Promise<SubjectMaskDetection> {
    if (this.backend !== 'self-hosted') {
      throw new SubjectMaskError('unsupported', 'Subject masks need the Self-Hosted server.');
    }
    try {
      return await detectServerSubjectMasks(this.injector, assetKey);
    } catch (err) {
      if (err instanceof SubjectMaskError) throw err;
      if (isHttpStatus(err, 404)) {
        throw new SubjectMaskError(
          'unavailable',
          'No segmentation is available for this photo yet.',
        );
      }
      throw new SubjectMaskError('failed', `Subject detection failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Register `recipe`'s raster and resolve with its registry id: memoized
   * id, else the IndexedDB PNG, else the server's PNG (cached on the way
   * in). Throws `unsupported` / `unavailable` / `failed` like `detect`.
   */
  ensureRaster(recipe: BitmapRecipe): Promise<number> {
    const memo = this.registered.get(recipe.digest);
    if (memo && memo.epoch === this.pipeline.currentWorkerEpoch()) {
      return Promise.resolve(memo.id);
    }
    const pending = this.inFlight.get(recipe.digest);
    if (pending) return pending;
    const task = this.resolveAndRegister(recipe).finally(() => this.inFlight.delete(recipe.digest));
    this.inFlight.set(recipe.digest, task);
    return task;
  }

  /**
   * Re-register every bitmap digest `layers` names — the sidecar-load path
   * (Apple's `rehydratedMaskRasters`). Tolerant per digest: a raster that
   * cannot be produced stays weight 0 (logged) rather than failing the
   * whole hydration. Never touches the store model.
   */
  async ensureBitmapRasters(layers: readonly LocalAdjustment[]): Promise<void> {
    for (const digest of bitmapDigestsIn(layers)) {
      try {
        await this.ensureRasterForDigest(digest);
      } catch (err) {
        console.warn(`Subject-mask raster ${digest} unresolved: ${errorMessage(err)}`);
      }
    }
  }

  /**
   * Forget `digests`' registry ids unless `remaining` still names them —
   * the layer-delete path. Deterministic (no refcount to drift): a digest
   * survives exactly while some layer carries it.
   */
  releaseDigests(digests: readonly string[], remaining: readonly LocalAdjustment[]): void {
    const live = new Set(bitmapDigestsIn(remaining));
    for (const digest of new Set(digests)) {
      if (live.has(digest)) continue;
      const memo = this.registered.get(digest);
      if (!memo) continue;
      this.registered.delete(digest);
      this.pipeline.releaseMaskRaster(memo.id);
    }
  }

  private async resolveAndRegister(recipe: BitmapRecipe): Promise<number> {
    const cached = await this.cache.get(recipe.digest).catch(() => null);
    if (cached) {
      try {
        return await this.registerDecoded(recipe.digest, cached.png);
      } catch {
        // A corrupt cached PNG falls through to the server refetch below.
      }
    }
    if (this.backend !== 'self-hosted') {
      throw new SubjectMaskError(
        'unsupported',
        'Subject masks need the Self-Hosted server (nothing cached).',
      );
    }
    let png: ArrayBuffer;
    try {
      png = await fetchServerSubjectMaskRasterBytes(this.injector, recipe.digest);
    } catch (err) {
      if (isHttpStatus(err, 404)) {
        throw new SubjectMaskError(
          'unavailable',
          'No segmentation is available for this photo yet.',
        );
      }
      throw new SubjectMaskError('failed', `Subject-mask fetch failed: ${errorMessage(err)}`);
    }
    let decoded;
    try {
      decoded = await this.decode(png);
    } catch (err) {
      throw new SubjectMaskError('failed', `Subject-mask decode failed: ${errorMessage(err)}`);
    }
    const id = await this.pipeline.registerMaskRaster({
      digest: recipe.digest,
      width: decoded.width,
      height: decoded.height,
      data: decoded.data,
    });
    this.registered.set(recipe.digest, { id, epoch: this.pipeline.currentWorkerEpoch() });
    await this.cache
      .put({ digest: recipe.digest, width: decoded.width, height: decoded.height, png })
      .catch(() => undefined);
    return id;
  }

  private async registerDecoded(digest: string, png: ArrayBuffer): Promise<number> {
    const decoded = await this.decode(png);
    const id = await this.pipeline.registerMaskRaster({
      digest,
      width: decoded.width,
      height: decoded.height,
      data: decoded.data,
    });
    this.registered.set(digest, { id, epoch: this.pipeline.currentWorkerEpoch() });
    return id;
  }

  private ensureRasterForDigest(digest: string): Promise<number> {
    // Rehydration only ever needs the digest — the recipe's other fields
    // are opaque identity data to the resolve path.
    return this.ensureRaster({ person: 0, facialSkin: true, bodySkin: true, model: '', digest });
  }
}
