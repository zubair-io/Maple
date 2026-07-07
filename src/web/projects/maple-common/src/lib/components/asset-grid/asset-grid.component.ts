// Asset grid — justified rows of thumbnail cells.
//
// Thumbnail acquisition is delegated to `LibraryStateService.ensureThumbnailUrl`
// (single source of truth for FS-walk / Mongo-asset / .maple-cache /
// decode-fallback paths). The shared `<maple-asset-thumb>` component
// fires that loader on mount, so this file only owns layout + selection.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { Asset, AssetId } from '../../models/asset';
import { GridFolderItem } from '../../models/folder';
import { AssetThumbComponent } from '../asset-thumb/asset-thumb.component';
import { FolderTileComponent } from '../folder-tile/folder-tile.component';
import { STORAGE_KEYS, TypedStorage } from '../../util/typed-storage';
import { parseAddress } from '../../addressing/maple-address';
import { viewRouteCommands } from '../../addressing/route-address';

export type GridItem = { kind: 'folder'; folder: GridFolderItem } | { kind: 'image'; asset: Asset };

interface GridRow {
  items: GridItem[];
  height: number;
}

@Component({
  selector: 'app-asset-grid',
  standalone: true,
  imports: [MapleIconComponent, ScrollingModule, AssetThumbComponent, FolderTileComponent],
  templateUrl: './asset-grid.component.html',
  styleUrl: './asset-grid.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssetGridComponent implements AfterViewInit, OnDestroy {
  @ViewChild('gridContainer', { read: ElementRef }) gridContainerRef!: ElementRef<HTMLElement>;

  /** Stable track-by for virtual scroll: keys off the first item's id so row
   * identity survives across re-packs of the same head item. Folder rows and
   * image rows share the same key space (folder ids are 'fs:<path>', asset
   * ids are UUIDs or 'fs:<path>' — disjoint by construction in practice). */
  trackRow = (_: number, row: GridRow): string => {
    const head = row.items[0];
    if (!head) return `r${_}`;
    return head.kind === 'image' ? head.asset.id : head.folder.id;
  };

  itemKey = (item: GridItem): string => (item.kind === 'image' ? item.asset.id : item.folder.id);

  itemAspectRatio = (item: GridItem): number =>
    item.kind === 'image' ? item.asset.aspectRatio : item.folder.aspectRatio;

  readonly state = inject(LibraryStateService);
  private readonly router = inject(Router);

  readonly STAR_INDICES = [1, 2, 3, 4, 5];

  private containerWidth = signal<number>(800);
  private ro?: ResizeObserver;

  readonly gridRows = computed((): GridRow[] => {
    const folders = this.state.foldersInSelectedFolder();
    const assets = this.state.assetsInSelectedFolder();
    const targetH = this.state.thumbSize();
    const containerW = this.containerWidth();
    const GAP = 3;

    // Folders sort first (Finder-style), then images.
    const items: GridItem[] = [
      ...folders.map<GridItem>((f) => ({ kind: 'folder', folder: f })),
      ...assets.map<GridItem>((a) => ({ kind: 'image', asset: a })),
    ];

    const rows: GridRow[] = [];
    let row: GridItem[] = [];
    let rowAr = 0;

    for (const item of items) {
      const ar = this.itemAspectRatio(item);
      row.push(item);
      rowAr += ar;
      const rowWidth = rowAr * targetH + (row.length - 1) * GAP;
      if (rowWidth >= containerW * 0.92) {
        const availW = containerW - (row.length - 1) * GAP - 6;
        const h = Math.min(targetH * 1.4, availW / rowAr);
        rows.push({ items: [...row], height: h });
        row = [];
        rowAr = 0;
      }
    }

    if (row.length) {
      const totalAr = row.reduce((s, it) => s + this.itemAspectRatio(it), 0);
      const availW = containerW - (row.length - 1) * GAP - 6;
      const h = Math.min(targetH, availW / totalAr);
      rows.push({ items: row, height: Math.max(h, 40) });
    }

    return rows;
  });

  filterLabel = computed(() => {
    const f = this.state.filter();
    if (f === 'picks') return 'Picks';
    if (f === '4stars') return '4+ stars';
    if (f === 'edited') return 'Edited';
    return 'All';
  });

  ngAfterViewInit(): void {
    if (!this.gridContainerRef) return;
    this.ro = new ResizeObserver((entries) => {
      for (const e of entries) this.containerWidth.set(e.contentRect.width);
    });
    this.ro.observe(this.gridContainerRef.nativeElement);
    this.containerWidth.set(this.gridContainerRef.nativeElement.clientWidth || 800);
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
  }

  // (Thumbnail loading moved to LibraryStateService.ensureThumbnailUrl —
  // both the asset-grid and the editor filmstrip go through the same
  // shared `<maple-asset-thumb>` component which fires the loader on mount.
  // The state service handles all four paths: FS-walk → /api/fs/thumb,
  // Mongo asset id → /api/assets/:id/thumb, .maple/ disk cache, and the
  // WASM-decode fallback with write-through.)

  // ── Event handlers ────────────────────────────────────────────────────────

  onThumbClick(asset: Asset, e: MouseEvent): void {
    this.state.selectAsset(asset.id, e.metaKey || e.ctrlKey, e.shiftKey);
  }

  onThumbDblClick(asset: Asset): void {
    this.state.selectAsset(asset.id);
    // Split the slug:relPath id into /view/:slug/** segments — passing the whole
    // id as one segment makes Preview resolve a bogus address and bounce back
    // to Browse.
    void this.router.navigate(viewRouteCommands(asset.id));
  }

  onFolderTileClick(folder: GridFolderItem): void {
    // Single click drills into the folder — same path the sidebar uses, so
    // selection state, sidebar expansion, and grid contents stay in sync.
    // After M2, folder.id is slug:relPath; derive relPath from it for the first
    // parameter (which openSelfHostedSubfolder now accepts as relPath).
    let relPath = folder.absPath ?? '';
    if (!relPath && folder.id.includes(':')) {
      try {
        relPath = parseAddress(folder.id).relPath;
      } catch {
        /* ignore */
      }
    }
    this.state.openSelfHostedSubfolder(relPath, folder.id);
    this.state.setFolderOpen(folder.id, true);
  }

  onThumbSizeChange(e: Event): void {
    const val = Number((e.target as HTMLInputElement).value);
    this.state.thumbSize.set(val);
    TypedStorage.setRaw(STORAGE_KEYS.THUMB_SIZE, String(val));
  }

  toggleSort(): void {
    const next = this.state.sort() === 'date' ? 'name' : 'date';
    this.state.sort.set(next);
    TypedStorage.set(STORAGE_KEYS.SORT, next);
  }

  cycleFilter(): void {
    const cur = this.state.filter();
    const next = cur === 'all' ? 'picks' : cur === 'picks' ? '4stars' : 'all';
    this.state.filter.set(next);
    TypedStorage.set(STORAGE_KEYS.FILTER, next);
  }
}
