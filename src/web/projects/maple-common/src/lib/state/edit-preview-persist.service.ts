// EditPreviewPersistService — the web editor's half of #1993's "editor
// creates the edited preview" contract (#2018; Apple counterpart is #2009).
//
// On a PIXEL-affecting edit, re-renders the DEVELOPED image (RAW + current
// XMP — the same develop the live canvas already shows) at the canonical
// 1280px-long-edge preview size and persists it to
// `<dir>/.maple/previews/<filename>.avif`, overwriting the unedited/prior
// preview in place (the same pure-cache file `HostedPreviewResolver`
// populates for the unedited tier, #2010).
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
//   - **Hosted (File System Access folder handle):** no server to fall back
//     to. Only a genuine AVIF is ever written — a browser that can't encode
//     AVIF writes NOTHING for this asset (never a JPEG wearing an `.avif`
//     extension), exactly mirroring `HostedPreviewResolver._persistAvif`'s
//     precedent for the unedited tier. It re-derives (from the still-current
//     embedded preview, or a future AVIF-capable browser) rather than ever
//     serving a stale/wrong developed preview.
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
import type { DecodedImage } from '../raw-pipeline/raw-pipeline.types';
import { LibraryStore } from './library-store.service';
import { LibraryCache } from './library-cache.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import {
  PREVIEW_LONG_EDGE_PX,
  encodeDevelopedRenderToAvif,
  encodeDevelopedRenderToJpeg,
} from '../raw-pipeline/image-utils';
import { parseAddress } from '../addressing/maple-address';
import { splitRelPath, validateRelPath } from '../addressing/fs-access-library-source';
import { isSupportedRaw } from './raw-extensions';

/** Idle debounce before a developed preview is persisted, in ms. Longer than
 * the 750ms sidecar-write debounce (`LibraryFetch.API_XMP_DEBOUNCE_MS`)
 * because this triggers a full decode + encode + disk/network write, not a
 * cheap text write — no value re-persisting mid-drag. */
const IDLE_PERSIST_DEBOUNCE_MS = 2000;

/** An asset's on-disk location within the granted Hosted library folder —
 * see `HostedPreviewResolver`'s identical type/helper, which this mirrors
 * (kept local rather than shared: the two resolvers key off different
 * inputs — an `AssetId` here as there, but this one has no `getBytes`
 * callback shape to unify around, so extracting a shared helper for ~10
 * lines would cost more than it saves). */
interface PreviewLocation {
  dir: string;
  filename: string;
}

@Injectable({ providedIn: 'root' })
export class EditPreviewPersistService {
  private readonly store = inject(LibraryStore);
  private readonly cache = inject(LibraryCache);
  private readonly mapleCache = inject(MapleCacheService);
  private readonly api = inject(BunApiBackendService);
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
    // Non-RAW assets are out of scope: `RawPipelineService.decode`'s non-RAW
    // branch (`decodeNonRawToRgb`) decodes browser-natively and does NOT
    // apply the `xmp` parameter at all (see that function's doc) — there is
    // no "developed" render to persist for a JPEG/PNG/HEIC source through
    // this code path, so persisting one would silently write an UNEDITED
    // preview under the edited contract. Skipping is correct, not a gap:
    // the unedited tier (#2010) already keeps that asset's preview current.
    if (!asset || !isSupportedRaw(asset.filename)) return;

    try {
      const bytes = this.cache.bytesFor(id) ?? (await this.cache.bytesForAsset(id));
      const ext = asset.filename.split('.').pop()?.toLowerCase() ?? '';
      const model = this.store.adjustmentFor(id)();
      const xmp = this.xmpSerializer.serialize(model);
      // Full quality (not the fast-phase half-res Preview demosaic) — this
      // is a persisted cache artifact, not a live-render tick.
      const img = await this.pipeline.decode(bytes, ext, xmp, PREVIEW_LONG_EDGE_PX, false);

      if (this.store.backend === 'self-hosted') {
        await this._persistServerBacked(id, img);
      } else {
        await this._persistHosted(id, img);
      }
    } catch (err) {
      console.warn('[state] developed-preview persist failed for', id, err);
    }
  }

  /** Server-backed (Self-Hosted): AVIF when this browser can genuinely
   * encode it, else a high-quality JPEG — `PUT /api/preview` (#2018)
   * transcodes a JPEG body to AVIF server-side, so this path always
   * persists something (unlike Hosted, which has no server to fall back
   * to). No-ops if the asset has no known on-disk path yet. */
  private async _persistServerBacked(id: AssetId, img: DecodedImage): Promise<void> {
    const absPath = this.store.absPathFor(id);
    if (!absPath) return;
    const avif = await encodeDevelopedRenderToAvif(img);
    if (avif) {
      await firstValueFrom(this.api.putPreview(absPath, avif, 'image/avif'));
      return;
    }
    const jpeg = await encodeDevelopedRenderToJpeg(img);
    await firstValueFrom(this.api.putPreview(absPath, jpeg, 'image/jpeg'));
  }

  /** Hosted (File System Access folder handle): only a genuine AVIF is ever
   * written (no server to transcode a JPEG fallback) — a browser that can't
   * canvas-encode AVIF writes nothing for this asset, matching
   * `HostedPreviewResolver._persistAvif`'s precedent for the unedited tier.
   * No-ops on a read-only or not-yet-resolved folder, or an asset with no
   * addressable on-disk location. */
  private async _persistHosted(id: AssetId, img: DecodedImage): Promise<void> {
    const folder = this.store.currentFolder();
    const location = this._locate(id);
    if (!folder?.write || !location) return;
    const avif = await encodeDevelopedRenderToAvif(img);
    if (!avif) return; // browser can't encode AVIF — defer, don't mislabel.
    await this.mapleCache.writePreview(folder, location.dir, location.filename, avif);
  }

  /** The asset's directory + basename, or `null` for an id with no
   * addressable folder location — mirrors `HostedPreviewResolver._locate`
   * (Hosted FS-Access asset ids are `slug:relPath` addresses; `fs:<absPath>`
   * and bare import ids are not). */
  private _locate(id: AssetId): PreviewLocation | null {
    if (typeof id !== 'string' || !id.includes(':') || id.startsWith('fs:')) return null;
    try {
      const { relPath } = parseAddress(id);
      validateRelPath(relPath);
      const { dir, filename } = splitRelPath(relPath);
      return filename ? { dir, filename } : null;
    } catch {
      return null;
    }
  }
}
