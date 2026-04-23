// Asset grid — justified rows of thumbnail cells.
// P5: thumbnails loaded from .maple/thumbs/ cache when available;
//     decoded + cached on first view; sha256Prefix16 used as cache key.
// P7: Router.navigate replaces window.location.href hack.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { LibraryStateService } from '../../state/library-state.service';
import { BunApiBackendService } from '../../api/bun-api-backend.service';
import { MapleCacheService } from '../../maple-cache/maple-cache.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { firstValueFrom } from 'rxjs';
import { imageDataToBitmap, resizeBitmapToCanvas } from '../../raw-pipeline/image-utils';
import { sha256Prefix16 } from '../../maple-cache/sha';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { Asset, AssetId } from '../../models/asset';

interface GridRow {
  assets: Asset[];
  height: number;
}

/** Convert a canvas to a JPEG Blob. */
async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality = 0.82,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      quality,
    );
  });
}

@Component({
  selector: 'app-asset-grid',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './asset-grid.component.html',
  styleUrl: './asset-grid.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssetGridComponent implements AfterViewInit, OnDestroy {
  @ViewChild('gridContainer') gridContainerRef!: ElementRef<HTMLElement>;

  readonly state = inject(LibraryStateService);
  readonly pipeline = inject(RawPipelineService);
  readonly mapCache = inject(MapleCacheService);
  private readonly api = inject(BunApiBackendService);
  private readonly router = inject(Router);

  readonly STAR_INDICES = [1, 2, 3, 4, 5];

  private containerWidth = signal<number>(800);
  private ro?: ResizeObserver;
  private cleanupThumbEffect?: () => void;

  // Per-cell thumbnail state (keyed by AssetId).
  readonly thumbUrls = signal<Map<AssetId, string>>(new Map());
  readonly thumbLoading = signal<Set<AssetId>>(new Set());

  // Track which assets we've already tried (avoid infinite retries on error).
  private attempted = new Set<AssetId>();

  readonly gridRows = computed((): GridRow[] => {
    const assets = this.state.assetsInSelectedFolder();
    const targetH = this.state.thumbSize();
    const containerW = this.containerWidth();
    const GAP = 3;

    const rows: GridRow[] = [];
    let row: Asset[] = [];
    let rowAr = 0;

    for (const asset of assets) {
      row.push(asset);
      rowAr += asset.aspectRatio;
      const rowWidth = rowAr * targetH + (row.length - 1) * GAP;
      if (rowWidth >= containerW * 0.92) {
        const availW = containerW - (row.length - 1) * GAP - 6;
        const h = Math.min(targetH * 1.4, availW / rowAr);
        rows.push({ assets: [...row], height: h });
        row = [];
        rowAr = 0;
      }
    }

    if (row.length) {
      const totalAr = row.reduce((s, a) => s + a.aspectRatio, 0);
      const availW = containerW - (row.length - 1) * GAP - 6;
      const h = Math.min(targetH, availW / totalAr);
      rows.push({ assets: row, height: Math.max(h, 40) });
    }

    return rows;
  });

  filterLabel = computed(() => {
    const f = this.state.filter();
    if (f === 'picks') return 'Picks';
    if (f === '4stars') return '4+ stars';
    return 'All';
  });

  ngAfterViewInit(): void {
    if (!this.gridContainerRef) return;
    this.ro = new ResizeObserver((entries) => {
      for (const e of entries) this.containerWidth.set(e.contentRect.width);
    });
    this.ro.observe(this.gridContainerRef.nativeElement);
    this.containerWidth.set(this.gridContainerRef.nativeElement.clientWidth || 800);

    // Watch asset list for new items and kick off thumbnail loads.
    const e = effect(() => {
      const assets = this.state.assetsInSelectedFolder();
      for (const asset of assets) {
        if (
          !this.thumbUrls().has(asset.id) &&
          !this.thumbLoading().has(asset.id) &&
          !this.attempted.has(asset.id)
        ) {
          this.attempted.add(asset.id);
          void this.loadThumbnail(asset);
        }
      }
    });
    this.cleanupThumbEffect = () => e.destroy();
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.cleanupThumbEffect?.();
    this.thumbUrls().forEach((url) => URL.revokeObjectURL(url));
  }

  // ── Thumbnail loading — cache-first ────────────────────────────────────────

  private async loadThumbnail(asset: Asset): Promise<void> {
    this.thumbLoading.update((s) => {
      const n = new Set(s);
      n.add(asset.id);
      return n;
    });

    try {
      // Self-Hosted: thumbs come from the API, not the local cache/decode path.
      if (this.state.backend === 'self-hosted') {
        const apiId = this.state.apiIdFor(asset.id);
        if (!apiId) return;
        // firstValueFrom: imperative-boundary escape hatch — loadThumbnail()
        // returns a Promise so the effect()-driven scheduler can dedupe.
        const blob = await firstValueFrom(this.api.getThumb(apiId));
        const url = URL.createObjectURL(blob);
        this.thumbUrls.update((m) => {
          const n = new Map(m);
          n.set(asset.id, url);
          return n;
        });
        this.state.cacheThumbnailUrl(asset.id, url);
        return;
      }

      const folder = this.state.currentFolder();

      // 1. Try .maple/ disk cache first (instant on warm cache).
      if (folder) {
        const sha = await sha256Prefix16(asset.filename);
        const cached = await this.mapCache.readThumb(folder, sha);
        if (cached) {
          const url = URL.createObjectURL(cached);
          this.thumbUrls.update((m) => {
            const n = new Map(m);
            n.set(asset.id, url);
            return n;
          });
          this.state.cacheThumbnailUrl(asset.id, url);
          return;
        }
      }

      // 2. Need to decode from bytes. Try lazy read first.
      let bytes: Uint8Array | undefined;
      try {
        bytes = await this.state.bytesForAsset(asset.id);
      } catch {
        // No handle and no legacy bytes — skip (mock assets, etc.).
        return;
      }

      const ext = asset.filename.split('.').pop()?.toLowerCase() ?? '';
      const decoded = await this.pipeline.decode(bytes, ext);

      // Update aspect ratio from decoded dimensions.
      this.state.updateAssetDimensions(asset.id, decoded.width, decoded.height);

      // Resize to thumbnail (512px long edge).
      const bitmap = await imageDataToBitmap(decoded);
      const canvas = await resizeBitmapToCanvas(bitmap, 512);
      bitmap.close();

      const blob = await canvasToBlob(canvas);
      const url = URL.createObjectURL(blob);

      this.thumbUrls.update((m) => {
        const n = new Map(m);
        n.set(asset.id, url);
        return n;
      });
      this.state.cacheThumbnailUrl(asset.id, url);

      // 3. Write thumb to .maple/ cache (non-blocking, write permission required).
      if (folder?.write) {
        const sha = await sha256Prefix16(asset.filename);
        void this.mapCache
          .writeThumb(folder, sha, blob)
          .then(() => this.state.updateIndexThumb(asset.id, sha));
      }
    } catch (err) {
      console.error(`Thumbnail decode failed for ${asset.filename}:`, err);
    } finally {
      this.thumbLoading.update((s) => {
        const n = new Set(s);
        n.delete(asset.id);
        return n;
      });
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  onThumbClick(asset: Asset, e: MouseEvent): void {
    this.state.selectAsset(asset.id, e.metaKey || e.ctrlKey, e.shiftKey);
  }

  onThumbDblClick(asset: Asset): void {
    this.state.selectAsset(asset.id);
    // P7: Router.navigate replaces window.location.href hack.
    void this.router.navigate(['/edit', asset.id]);
  }

  onThumbSizeChange(e: Event): void {
    const val = Number((e.target as HTMLInputElement).value);
    this.state.thumbSize.set(val);
    try {
      localStorage.setItem('cm.thumbSize', String(val));
    } catch {
      /* noop */
    }
  }

  toggleSort(): void {
    const next = this.state.sort() === 'date' ? 'name' : 'date';
    this.state.sort.set(next);
    try {
      localStorage.setItem('cm.sort', JSON.stringify(next));
    } catch {
      /* noop */
    }
  }

  cycleFilter(): void {
    const cur = this.state.filter();
    const next = cur === 'all' ? 'picks' : cur === 'picks' ? '4stars' : 'all';
    this.state.filter.set(next);
    try {
      localStorage.setItem('cm.filter', JSON.stringify(next));
    } catch {
      /* noop */
    }
  }
}
