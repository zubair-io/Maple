// EditPreviewPersistService — the web editor's half of #1993's "editor
// creates the edited preview" contract (#2018; Apple counterpart is #2009).
//
// On a PIXEL-affecting edit, re-renders the DEVELOPED image (RAW + current
// XMP — the same develop the live canvas already shows) at the canonical
// 1280px-long-edge preview size and persists it to
// `<dir>/.maple/previews/<filename>.<actual-format>`, replacing the
// unedited/prior preview selected by the same Hosted-private descriptor
// `HostedPreviewResolver` populates for the unedited tier (#2010).
//
// WRITE POLICY (load-bearing — see CLAUDE.md's performance invariants and
// the #2018 ticket): `schedule()` is called from `LibraryStateService.
// updateAdjustment` on EVERY slider tick, but it only arms an idle debounce
// — the actual decode + encode + write happens once, after the user stops
// editing for `IDLE_PERSIST_DEBOUNCE_MS`. This is a SEPARATE, bounded decode
// from the live two-phase render (`ImageCanvasComponent`'s fast/refine
// phases) — it does not touch the render loop, add allocation per tick, or
// cross the WASM boundary per tick; it shares the same `RawPipelineService`
// single-in-flight decode queue, so it simply queues behind (never
// alongside) any in-flight live render. `flushAll()` is the exit/navigate-
// away/close counterpart, mirroring `LibraryFetch.flushPendingXmpWrites`'s
// role for the sidecar debounce — see `EditorShellComponent`'s
// `onBeforeUnload`/`ngOnDestroy`.
//
// This service (not `LibraryFetch`, which already owns the sidecar-write
// debounce) exists standalone purely to stay under this repo's file-size
// budget (`tools/check-file-budget.sh`) — `library-fetch.service.ts` is
// already ~3x the 400-line soft limit — the same reasoning
// `HostedPreviewResolver` was already extracted for.
//
// AVIF-encode reality (#2018, following directly from #2010's measurement
// that no shipping browser's canvas can genuinely encode AVIF today):
//   - **Hosted (File System Access folder handle):** stores genuine AVIF when
//     available, otherwise a high-quality JPEG with its real extension/MIME in
//     the Hosted-private descriptor. This cache stays local and is not an
//     interchange contract.
//   - **Server-backed (Self-Hosted):** `PUT /api/preview` (#2018) accepts
//     JPEG as well as AVIF, transcoding server-side via the same isolated
//     sharp pipeline the index-time preview stage uses
//     (`routes/preview.ts`). So the server-backed path encodes AVIF when
//     possible, and otherwise falls back to a HIGH-quality JPEG
//     (`encodeDevelopedRenderToJpeg`) rather than deferring — this path
//     genuinely persists the edited preview on every browser today.

import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AssetId } from '../models/asset';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import type { DecodedImage } from '../raw-pipeline/raw-pipeline.types';
import { LibraryStore } from './library-store.service';
import { LibraryCache } from './library-cache.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import {
  samePreviewSource,
  type PreviewSourceIdentity,
} from '../maple-cache/preview-cache-protocol';
import { SERVER_WORKSPACE_PERSISTENCE } from '../workspace/workspace-persistence';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import {
  PREVIEW_LONG_EDGE_PX,
  encodeDevelopedRenderToAvif,
  encodeDevelopedRenderToJpeg,
} from '../raw-pipeline/image-utils';
import { isSupportedRaw } from './raw-extensions';
import { previewLocation, type PreviewLocation } from './preview-location';

/** Idle debounce before a developed preview is persisted, in ms. Longer than
 * the 150ms sidecar-write debounce (`XmpStoreService`)
 * because this triggers a full decode + encode + disk/network write, not a
 * cheap text write — no value re-persisting mid-drag. */
const IDLE_PERSIST_DEBOUNCE_MS = 2000;

interface HostedPreviewTarget {
  folder: MapleFolderHandle;
  location: PreviewLocation;
  sourceBefore: PreviewSourceIdentity;
}

@Injectable({ providedIn: 'root' })
export class EditPreviewPersistService {
  private readonly store = inject(LibraryStore);
  private readonly cache = inject(LibraryCache);
  private readonly mapleCache = inject(MapleCacheService);
  private readonly serverPersistence = inject(SERVER_WORKSPACE_PERSISTENCE);
  private readonly pipeline = inject(RawPipelineService);
  private readonly xmpSerializer = inject(XmpSerializerService);

  private readonly _timers = new Map<AssetId, ReturnType<typeof setTimeout>>();

  /**
   * Arm (or re-arm) the idle debounce for `id`. Call on every pixel-affecting
   * edit (`LibraryStateService.updateAdjustment` — NOT the culling mutators;
   * a rating/flag/colorLabel/keyword change doesn't touch pixels, so it must
   * not re-trigger this). Safe to call for any asset id, including ids this
   * service will later decide not to persist (non-RAW, no addressable
   * location) — `_persist` no-ops cleanly in those cases.
   */
  schedule(id: AssetId): void {
    const existing = this._timers.get(id);
    if (existing) clearTimeout(existing);
    const timeout = setTimeout(() => {
      this._timers.delete(id);
      void this._persist(id);
    }, IDLE_PERSIST_DEBOUNCE_MS);
    this._timers.set(id, timeout);
  }

  /**
   * Immediately fire every pending persist (skipping the remaining debounce
   * wait) and clear the timers. Call on navigate-away / close / editor
   * teardown (`EditorShellComponent`'s `onBeforeUnload` and `ngOnDestroy`) —
   * mirrors `LibraryFetch.flushPendingXmpWrites`'s role for the sidecar
   * debounce. Fire-and-forget: callers don't await completion (the same
   * `beforeunload`-can't-reliably-await reality `flushPendingXmpWrites`
   * already documents), so a persist in flight when the tab actually closes
   * may be lost — acceptable for a pure, re-derivable cache entry.
   */
  flushAll(): void {
    for (const [id, timer] of this._timers.entries()) {
      clearTimeout(timer);
      void this._persist(id);
    }
    this._timers.clear();
  }

  /** Decode the developed render at the canonical preview size and route to
   * the Hosted or server-backed write path. Every failure (decode, encode,
   * network, disk) is caught and logged — this is a cache write, never
   * allowed to surface as a user-visible error or affect the editor. */
  private async _persist(id: AssetId): Promise<void> {
    const asset = this.store.findAsset(id);
    // There is no longer a decode-side reason to skip non-RAW assets here:
    // `RawPipelineService.decode`'s non-RAW branch DOES now apply `xmp` via
    // the WASM `develop_non_raw` entry (#3039 fixed the canvas-side bug this
    // used to describe — a JPEG opened in the editor genuinely IS edited and
    // has a real developed render). Per-branch target-resolution safety is
    // checked below instead of gated blanket here (#3048):
    //   - Self-hosted (`_persistServerBacked` / `PUT /api/preview`): safe for
    //     any filename — `absPathFor`, the route, and its `GET /api/preview`
    //     reader are all extension-agnostic.
    //   - Hosted (below): still RAW-only — see the guard there.
    if (!asset) return;

    try {
      if (this.store.backend === 'hosted') {
        const hostedTarget = await this._resolveHostedTarget(id, asset.filename);
        if (!hostedTarget) return;
        await this._decodeAndPersist(id, asset.filename, hostedTarget.bytes, hostedTarget.target);
        return;
      }
      // Resolve the server-backed target BEFORE the expensive fetch +
      // decode + encode: a non-addressable id (e.g. a bare-UUID single-file
      // session) has no on-disk path, and `_persistServerBacked` would
      // no-op after all that work on every idle debounce.
      if (!this.store.absPathFor(id) || !this.serverPersistence) return;
      const bytes = this.cache.bytesFor(id) ?? (await this.cache.bytesForAsset(id));
      await this._decodeAndPersist(id, asset.filename, bytes, hostedTarget);
    } catch (err) {
      console.warn('[state] developed-preview persist failed for', id, err);
    }
  }

  /** Hosted target resolution, hoisted out of `_persist` so the router
   * stays flat. Returns null when the write must be skipped:
   * - Non-RAW assets: Hosted's cache slot has exactly one reader today —
   *   `HostedPreviewResolver.resolve()` — and it unconditionally skips
   *   non-RAW assets before ever calling `readPreview()` ("No
   *   embedded-preview concept for a non-RAW still (already display-ready
   *   pixels)", hosted-preview-resolver.service.ts). Writing here would
   *   decode + encode + hit disk on every idle-debounce for a file nothing
   *   reads back — an orphaned write. Stays gated until that reader grows
   *   a non-RAW branch (separate ticket, out of scope for #3048).
   * - No writable folder or addressable preview location. */
  private async _resolveHostedTarget(
    id: AssetId,
    filename: string,
  ): Promise<{ target: HostedPreviewTarget; bytes: Uint8Array } | null> {
    if (!isSupportedRaw(filename)) return null;
    const folder = this.store.currentFolder();
    const location = previewLocation(id);
    if (!folder?.write || !location) return null;
    const snapshot = await this.cache.hostedBytes.snapshotFor(id);
    return {
      target: { folder, location, sourceBefore: snapshot.source },
      bytes: snapshot.bytes,
    };
  }

  private async _decodeAndPersist(
    id: AssetId,
    filename: string,
    bytes: Uint8Array,
    hostedTarget: HostedPreviewTarget | null,
  ): Promise<void> {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const model = this.store.adjustmentFor(id)();
    const xmp = this.xmpSerializer.serialize(model);
    // Full quality (not the fast-phase half-res Preview demosaic) — this
    // is a persisted cache artifact, not a live-render tick.
    const img = await this.pipeline.decode(bytes, ext, xmp, PREVIEW_LONG_EDGE_PX, false);

    if (this.store.backend === 'self-hosted') {
      await this._persistServerBacked(id, img);
    } else if (hostedTarget) {
      await this._persistHosted(id, img, hostedTarget);
    }
  }

  /** Server-backed (Self-Hosted): AVIF when this browser can genuinely
   * encode it, else a high-quality JPEG — `PUT /api/preview` (#2018)
   * transcodes a JPEG body to AVIF server-side, so this path always
   * persists something (unlike Hosted, which has no server to fall back
   * to). No-ops if the asset has no known on-disk path yet. */
  private async _persistServerBacked(id: AssetId, img: DecodedImage): Promise<void> {
    const absPath = this.store.absPathFor(id);
    if (!absPath || !this.serverPersistence) return;
    const avif = await encodeDevelopedRenderToAvif(img);
    if (avif) {
      await firstValueFrom(this.serverPersistence.writePreview(absPath, avif, 'image/avif'));
      return;
    }
    const jpeg = await encodeDevelopedRenderToJpeg(img);
    await firstValueFrom(this.serverPersistence.writePreview(absPath, jpeg, 'image/jpeg'));
  }

  /** Hosted (File System Access folder handle): genuine AVIF when supported,
   * otherwise a high-quality JPEG stored under its actual declared format.
   * No-ops on a read-only or not-yet-resolved folder, an asset with no
   * addressable on-disk location, or unavailable source identity. */
  private async _persistHosted(
    id: AssetId,
    img: DecodedImage,
    target: HostedPreviewTarget,
  ): Promise<void> {
    if (this.store.currentFolder() !== target.folder || !target.folder.write) return;
    const avif = await encodeDevelopedRenderToAvif(img);
    const blob = avif ?? (await encodeDevelopedRenderToJpeg(img));
    const sourceAfter = await this.cache.hostedBytes.identityFor(id);
    if (!samePreviewSource(target.sourceBefore, sourceAfter)) return;
    await this.mapleCache.writePreview(
      target.folder,
      target.location.dir,
      target.location.filename,
      blob,
      target.sourceBefore,
    );
  }
}
