// Asset grid — justified rows of thumbnail cells.
//
// Thumbnail acquisition is delegated to `LibraryStateService.ensureThumbnailUrl`
// (single source of truth for FS-walk / Mongo-asset / .maple-cache /
// decode-fallback paths). The shared `<maple-asset-tile>` component fires
// that loader on mount, so this file only owns layout + selection.

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
import { DragDropModule } from '@angular/cdk/drag-drop';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { Asset, AssetId } from '../../models/asset';
import { GridFolderItem } from '../../models/folder';
import { AssetTileComponent } from '../asset-tile/asset-tile.component';
import { FolderTileComponent } from '../folder-tile/folder-tile.component';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';
import { STORAGE_KEYS, TypedStorage } from '../../util/typed-storage';
import { parseAddress } from '../../addressing/maple-address';
import { viewRouteCommands } from '../../addressing/route-address';
import { DRAG_MOVE_CAPABILITY } from '../../drag-move/drag-move-capability';
import { ASSET_GRID_DROP_LIST_ID, type AssetDragData } from '../../drag-move/asset-drag-data';

export type GridItem = { kind: 'folder'; folder: GridFolderItem } | { kind: 'image'; asset: Asset };

interface GridRow {
  items: GridItem[];
  height: number;
}

@Component({
  selector: 'app-asset-grid',
  standalone: true,
  imports: [
    MapleIconComponent,
    MuiButtonComponent,
    ScrollingModule,
    DragDropModule,
    AssetTileComponent,
    FolderTileComponent,
  ],
  templateUrl: './asset-grid.component.html',
  styleUrl: './asset-grid.component.scss',
  host: { class: 'flex flex-col min-h-0 flex-1' },
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
  protected readonly dragMove = inject(DRAG_MOVE_CAPABILITY);
  protected readonly assetGridDropListId = ASSET_GRID_DROP_LIST_ID;

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
  // asset-grid's `<maple-asset-tile>` and the editor filmstrip's
  // `<maple-asset-thumb>` each fire the loader on mount from their own copy
  // of the same effect. The state service handles all four paths: FS-walk →
  // /api/fs/thumb, Mongo asset id → /api/assets/:id/thumb, .maple/ disk
  // cache, and the WASM-decode fallback with write-through.)

  // ── Event handlers ────────────────────────────────────────────────────────

  /**
   * Grid click semantics (#2404 — matches Apple's single-tap-opens model):
   * a plain click selects and navigates to `/view/…`; Cmd/Ctrl-click and
   * Shift-click each mutate the selection (toggle / range-extend) and never
   * navigate; while Select mode is on, a click toggles membership (Shift
   * still range-extends — #2976) and never navigates. Double-click-to-open
   * no longer exists — a plain click already navigates, so a second click
   * lands on a torn-down component.
   */
  onThumbClick(asset: Asset, e: MouseEvent): void {
    if (this.state.isSelecting()) {
      this.state.selectAsset(asset.id, !e.shiftKey, e.shiftKey);
      return;
    }

    const additive = e.metaKey || e.ctrlKey;
    const range = e.shiftKey;
    this.state.selectAsset(asset.id, additive, range);
    if (additive || range) return;

    // Split the slug:relPath id into /view/:slug/** segments — passing the whole
    // id as one segment makes Preview resolve a bogus address and bounce back
    // to Browse.
    void this.router.navigate(viewRouteCommands(asset.id));
  }

  /**
   * Folder tiles share the photo tiles' selection gestures (#2976):
   * Cmd/Ctrl-click toggles, Shift-click range-extends across the folder
   * block, and Select mode makes every click a toggle — none of those
   * navigate. Only a plain click outside Select mode drills in.
   */
  onFolderTileClick(folder: GridFolderItem, e: MouseEvent): void {
    if (this.state.isSelecting()) {
      this.state.selectFolder(folder.id, !e.shiftKey, e.shiftKey);
      return;
    }
    const additive = e.metaKey || e.ctrlKey;
    const range = e.shiftKey;
    if (additive || range) {
      this.state.selectFolder(folder.id, additive, range);
      return;
    }

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

  // ── Drag-move / drag-copy source (#2644) ───────────────────────────────
  // Only image tiles are draggable — grid-to-folder-tree move/copy is
  // scoped to assets (the ticket title, and the design doc's "Drag assets
  // from the grid"); dragging a grid folder tile is a different, unscoped
  // feature. `dragEnabled` gates whether tiles are draggable at all (NOOP
  // capability → always `false` on Hosted); `dragDataFor` still has to
  // exist unconditionally because `cdkDrag`'s `[cdkDragData]` binding is
  // evaluated regardless of `[cdkDragDisabled]`.

  dragEnabled(): boolean {
    return this.dragMove.available();
  }

  isDraggable(item: GridItem): boolean {
    return item.kind === 'image' && this.dragEnabled();
  }

  /** The current folder every item in the grid lives under — the grid only
   * ever shows one folder's contents, so this is the same for every drag. */
  private currentFolderId(): string {
    return this.state.selectedSourceId();
  }

  dragDataFor(item: GridItem): AssetDragData {
    if (item.kind !== 'image') return { assetIds: [], sourceFolderId: this.currentFolderId() };
    const selected = this.state.selectedAssetIds();
    // Multi-select drag carries the whole selection only when the dragged
    // tile is part of it (design doc) — dragging a tile OUTSIDE the current
    // selection drags just that one tile, leaving the selection untouched.
    const assetIds =
      selected.size > 1 && selected.has(item.asset.id) ? [...selected] : [item.asset.id];
    return { assetIds, sourceFolderId: this.currentFolderId() };
  }

  dragPreviewLabel(item: GridItem): string {
    if (item.kind !== 'image') return '';
    const data = this.dragDataFor(item);
    return data.assetIds.length > 1 ? `${data.assetIds.length} photos` : item.asset.filename;
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
