// Asset grid — justified rows of thumbnail cells.
// For imported assets (those with fileBytes), real decoded thumbnails are shown.
// Mock assets continue to use gradient swatches.

import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  LibraryStateService,
  RawPipelineService,
  imageDataToBitmap,
  resizeBitmapToCanvas,
  canvasToBlobUrl,
} from '@maple-common';
import { MapleIconComponent } from '@maple-common';
import { Asset, AssetId } from '@maple-common';

interface GridRow {
  assets: Asset[];
  height: number;
}

@Component({
  selector: 'app-asset-grid',
  standalone: true,
  imports: [MapleIconComponent],
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      flex: 1;
    }

    /* Toolbar */
    .toolbar {
      height: 40px;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 14px;
      background: var(--maple-bg);
      border-bottom: 0.5px solid var(--maple-border);
      flex-shrink: 0;
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 4px;
      font-family: var(--maple-font);
      font-size: 11px;
    }
    .breadcrumb .crumb-sep {
      color: var(--maple-text-muted);
      margin: 0 2px;
    }
    .breadcrumb .crumb-active { color: var(--maple-text-main); }
    .breadcrumb .crumb-dim    { color: var(--maple-text-muted); }

    .spacer { flex: 1; }

    .size-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--maple-font);
      font-size: 11px;
      color: var(--maple-text-muted);
    }
    .size-row input[type=range] {
      width: 80px;
      accent-color: var(--maple-primary);
      cursor: pointer;
    }

    .divider {
      width: 0.5px;
      height: 18px;
      background: var(--maple-border);
    }

    .pill-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 22px;
      padding: 0 8px;
      border-radius: 4px;
      background: var(--maple-surface);
      color: var(--maple-text-main);
      font-family: var(--maple-font);
      font-size: 11px;
      border: 0.5px solid var(--maple-border);
      cursor: pointer;
      transition: background 120ms;
    }
    .pill-btn:hover { background: var(--maple-surface-hover); }
    .pill-btn.active {
      background: var(--maple-primary-dim);
      color: var(--maple-primary);
      border-color: var(--maple-primary);
    }

    .count-label {
      font-family: var(--maple-font-mono);
      font-size: 10px;
      color: var(--maple-text-muted);
      font-variant-numeric: tabular-nums;
    }

    /* Grid */
    .grid-scroll {
      flex: 1;
      background: var(--maple-bg);
      overflow-y: auto;
      padding: 3px;
    }
    .grid-scroll::-webkit-scrollbar { width: 8px; }
    .grid-scroll::-webkit-scrollbar-track { background: transparent; }
    .grid-scroll::-webkit-scrollbar-thumb {
      background: var(--maple-border);
      border-radius: 4px;
    }

    .grid-row {
      display: flex;
      gap: 3px;
      margin-bottom: 3px;
    }

    .thumb {
      position: relative;
      border-radius: 2px;
      cursor: pointer;
      outline: none;
      background-size: cover;
      background-position: center;
      flex-shrink: 0;
      overflow: hidden;
    }
    .thumb.selected {
      outline: 2px solid var(--maple-primary);
      outline-offset: -2px;
    }

    .thumb-img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .thumb-loading {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--maple-font);
      font-size: 9px;
      color: var(--maple-text-muted);
    }

    /* XMP badge (top-right) */
    .xmp-badge {
      position: absolute;
      top: 5px;
      right: 5px;
      width: 14px;
      height: 14px;
      border-radius: 3px;
      background: var(--maple-success-bg);
      border: 0.5px solid var(--maple-success-text);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--maple-success-text);
      backdrop-filter: blur(4px);
    }

    /* Bottom badges row */
    .bottom-badges {
      position: absolute;
      left: 5px;
      bottom: 5px;
      right: 5px;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 4px;
      pointer-events: none;
    }

    .flag-badge {
      font-size: 9px;
      font-weight: 600;
      padding: 2px 4px;
      border-radius: 3px;
      letter-spacing: 0.3px;
      font-family: var(--maple-font);
      backdrop-filter: blur(4px);
    }
    .flag-pick   { background: var(--maple-success-bg); color: var(--maple-success-text); }
    .flag-reject { background: var(--maple-error-bg);   color: var(--maple-error-text); }

    .stars-badge {
      display: flex;
      gap: 1px;
      background: rgba(0,0,0,0.45);
      padding: 2px 4px;
      border-radius: 3px;
      backdrop-filter: blur(4px);
    }
  `],
  template: `
    <!-- Toolbar -->
    <div class="toolbar">
      <!-- Breadcrumb -->
      <div class="breadcrumb">
        <span class="crumb-dim">Local files</span>
        <span class="crumb-sep">›</span>
        <span class="crumb-dim">2026</span>
        <span class="crumb-sep">›</span>
        <span class="crumb-active">France trip</span>
      </div>

      <div class="spacer"></div>

      <!-- Thumb size slider -->
      <div class="size-row">
        <maple-icon name="grid-sm" [size]="11" color="var(--maple-text-muted)"/>
        <input type="range" min="60" max="220"
          [value]="state.thumbSize()"
          (input)="onThumbSizeChange($event)"/>
        <maple-icon name="grid-lg" [size]="13" color="var(--maple-text-muted)"/>
      </div>

      <div class="divider"></div>

      <!-- Sort pill -->
      <div class="pill-btn" [class.active]="state.sort() === 'date'" (click)="toggleSort()">
        <maple-icon name="sort" [size]="11"/>
        <span>{{ state.sort() === 'date' ? 'Date' : 'Name' }}</span>
      </div>

      <!-- Filter pill -->
      <div class="pill-btn" [class.active]="state.filter() !== 'all'" (click)="cycleFilter()">
        <maple-icon name="filter" [size]="11"/>
        <span>{{ filterLabel() }}</span>
      </div>

      <div class="divider"></div>

      <span class="count-label">
        @if (state.selectedCount() > 0) {
          {{ state.selectedCount() }} selected
        } @else {
          {{ state.assetsInSelectedFolder().length }} photos
        }
      </span>
    </div>

    <!-- Justified grid -->
    <div class="grid-scroll" #gridContainer>
      @for (row of gridRows(); track $index) {
        <div class="grid-row">
          @for (asset of row.assets; track asset.id) {
            @let isSelected = state.selectedAssetIds().has(asset.id);
            @let thumbUrl = thumbUrls().get(asset.id);
            @let isLoading = thumbLoading().has(asset.id);
            <div
              class="thumb"
              [class.selected]="isSelected"
              [style.width.px]="asset.aspectRatio * row.height"
              [style.height.px]="row.height"
              [style.background-image]="thumbUrl ? '' : ('url(' + asset.thumbnailGradient + ')')"
              (click)="onThumbClick(asset, $event)"
              (dblclick)="onThumbDblClick(asset)"
            >
              <!-- Real decoded thumbnail -->
              @if (thumbUrl) {
                <img class="thumb-img" [src]="thumbUrl" alt="">
              }

              <!-- Loading spinner for in-progress decodes -->
              @if (isLoading && !thumbUrl) {
                <div class="thumb-loading">...</div>
              }

              <!-- XMP badge -->
              @if (asset.edited) {
                <div class="xmp-badge">
                  <maple-icon name="check" [size]="9" [strokeWidth]="2" color="var(--maple-success-text)"/>
                </div>
              }

              <!-- Bottom badges -->
              <div class="bottom-badges">
                <!-- Flag badge -->
                <div style="display:flex;gap:3px">
                  @if (asset.flag === 'pick') {
                    <div class="flag-badge flag-pick">PICK</div>
                  }
                  @if (asset.flag === 'reject') {
                    <div class="flag-badge flag-reject">REJECT</div>
                  }
                </div>

                <!-- Stars -->
                @if (asset.rating > 0) {
                  <div class="stars-badge">
                    @for (i of STAR_INDICES; track i) {
                      <maple-icon
                        [name]="i <= asset.rating ? 'star-filled' : 'star'"
                        [size]="8"
                        [color]="i <= asset.rating ? 'var(--maple-star)' : 'rgba(255,255,255,0.35)'"/>
                    }
                  </div>
                }
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class AssetGridComponent implements AfterViewInit, OnDestroy {
  @ViewChild('gridContainer') gridContainerRef!: ElementRef<HTMLElement>;

  state    = inject(LibraryStateService);
  pipeline = inject(RawPipelineService);

  readonly STAR_INDICES = [1, 2, 3, 4, 5];

  private containerWidth = signal<number>(800);
  private ro?: ResizeObserver;
  private cleanupThumbEffect?: () => void;

  // Per-cell thumbnail state (keyed by AssetId).
  readonly thumbUrls    = signal<Map<AssetId, string>>(new Map());
  readonly thumbLoading = signal<Set<AssetId>>(new Set());

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
        const totalAr = rowAr;
        const availW = containerW - (row.length - 1) * GAP - 6;
        const h = Math.min(targetH * 1.4, availW / totalAr);
        rows.push({ assets: [...row], height: h });
        row = [];
        rowAr = 0;
      }
    }

    // Last incomplete row
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
    if (f === 'picks')  return 'Picks';
    if (f === '4stars') return '4+ stars';
    return 'All';
  });

  ngAfterViewInit(): void {
    if (!this.gridContainerRef) return;
    this.ro = new ResizeObserver(entries => {
      for (const e of entries) {
        this.containerWidth.set(e.contentRect.width);
      }
    });
    this.ro.observe(this.gridContainerRef.nativeElement);
    this.containerWidth.set(this.gridContainerRef.nativeElement.clientWidth || 800);

    // Watch for new assets to generate their thumbnails.
    const e = effect(() => {
      const assets = this.state.assetsInSelectedFolder();
      for (const asset of assets) {
        if (this.state.bytesFor(asset.id) && !this.thumbUrls().has(asset.id) && !this.thumbLoading().has(asset.id)) {
          void this.loadThumbnail(asset);
        }
      }
    });
    this.cleanupThumbEffect = () => e.destroy();
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.cleanupThumbEffect?.();
    // Revoke all blob URLs to free memory.
    this.thumbUrls().forEach(url => URL.revokeObjectURL(url));
  }

  private async loadThumbnail(asset: Asset): Promise<void> {
    // Mark as in-flight.
    this.thumbLoading.update(s => { const n = new Set(s); n.add(asset.id); return n; });

    try {
      const bytes = this.state.bytesFor(asset.id);
      if (!bytes) return;
      const ext = asset.filename.split('.').pop()?.toLowerCase() ?? '';
      const decoded = await this.pipeline.decode(bytes, ext);

      // Update aspect ratio from real decoded dimensions.
      this.state.updateAssetDimensions(asset.id, decoded.width, decoded.height);

      // Downscale to thumbnail.
      const bitmap = await imageDataToBitmap(decoded);
      const canvas = await resizeBitmapToCanvas(bitmap, 512);
      const url = await canvasToBlobUrl(canvas);
      bitmap.close();

      this.thumbUrls.update(m => { const n = new Map(m); n.set(asset.id, url); return n; });
      this.state.cacheThumbnailUrl(asset.id, url);
    } catch (err) {
      console.error(`Thumbnail decode failed for ${asset.filename}:`, err);
    } finally {
      this.thumbLoading.update(s => { const n = new Set(s); n.delete(asset.id); return n; });
    }
  }

  onThumbClick(asset: Asset, e: MouseEvent): void {
    const additive = e.metaKey || e.ctrlKey;
    const range    = e.shiftKey;
    this.state.selectAsset(asset.id, additive, range);
  }

  onThumbDblClick(asset: Asset): void {
    this.state.selectAsset(asset.id);
    const editorBase = window.location.port === '4200'
      ? `http://localhost:4300`
      : `${window.location.origin}`;
    window.location.href = `${editorBase}/edit/${asset.id}`;
  }

  onThumbSizeChange(e: Event): void {
    const val = Number((e.target as HTMLInputElement).value);
    this.state.thumbSize.set(val);
    try { localStorage.setItem('cm.thumbSize', String(val)); } catch { /* noop */ }
  }

  toggleSort(): void {
    const next = this.state.sort() === 'date' ? 'name' : 'date';
    this.state.sort.set(next);
    try { localStorage.setItem('cm.sort', JSON.stringify(next)); } catch { /* noop */ }
  }

  cycleFilter(): void {
    const cur = this.state.filter();
    const next = cur === 'all' ? 'picks' : cur === 'picks' ? '4stars' : 'all';
    this.state.filter.set(next);
    try { localStorage.setItem('cm.filter', JSON.stringify(next)); } catch { /* noop */ }
  }
}
