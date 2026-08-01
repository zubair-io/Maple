// BrowseShell — 3-column layout + window chrome + keyboard handling.
// Ported from _design-reference/app.jsx (WindowChrome + App layout).
// P7: window.location.href navigation replaced by Router.

import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { LibraryStateService } from '../../state/library-state.service';
import { LAST_SOURCE_KEY } from '../../state/library-fetch.service';
import { TypedStorage } from '../../util/typed-storage';
import { parseAddress, formatAddress } from '../../addressing/maple-address';
import {
  routeSegmentsToAddress,
  addressToRouteSegments,
  viewRouteCommands,
} from '../../addressing/route-address';
import { LayoutService } from '../../layout-service';
import { FolderTreeComponent } from '../../components/folder-tree/folder-tree.component';
import { SourcePickerDrawerComponent } from '../source-picker-drawer/source-picker-drawer.component';
import { ToolbarActionsComponent } from './toolbar-actions/toolbar-actions.component';
import { AssetGridComponent } from '../../components/asset-grid/asset-grid.component';
import { DropZoneComponent } from '../../components/drop-zone/drop-zone.component';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { PasteSettingsDialogComponent } from '../../editor/copy-paste/paste-settings-dialog.component';
import { AdjustmentClipboardService } from '../../editor/copy-paste/adjustment-clipboard.service';
import {
  ALL_ADJUSTMENT_GROUP_IDS,
  buildGroupPatch,
  type AdjustmentGroupId,
} from '../../editor/copy-paste/adjustment-groups';
import { selectSidebarEntry } from './source-selection';

@Component({
  selector: 'browse-shell',
  standalone: true,
  imports: [
    FolderTreeComponent,
    AssetGridComponent,
    DropZoneComponent,
    MapleIconComponent,
    PasteSettingsDialogComponent,
    SourcePickerDrawerComponent,
    ToolbarActionsComponent,
  ],
  templateUrl: './browse-shell.component.html',
  styleUrl: './browse-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowseShellComponent {
  readonly showServerSearch = input(false);
  readonly serverSearchRequested = output<void>();

  state = inject(LibraryStateService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private readonly clipboard = inject(AdjustmentClipboardService);
  private readonly layoutService = inject(LayoutService);

  /** Active breakpoint — drives the source sidebar (inline pane vs phone
   * overlay drawer) and the toolbar action collapse. See `LayoutService`. */
  protected readonly layout = this.layoutService.layout;

  /** True while the phone source-picker drawer is open (#2280). */
  readonly sourceDrawerOpen = signal(false);
  openSourceDrawer(): void {
    this.sourceDrawerOpen.set(true);
  }

  /** Selecting a source from the phone drawer shares the inline tree's
   * FS-walk-vs-plain-id branch — see the `selectSidebarEntry` helper. */
  onDrawerSourceSelected(id: string): void {
    selectSidebarEntry(this.state, id);
  }

  // ── Copy / paste / sync develop settings (#944) ───────────────────────────
  /** True when the selective-paste dialog is open. */
  readonly pasteDialogVisible = signal(false);

  /** True when a focused asset exists to copy settings from. */
  readonly canCopySettings = computed(() => this.state.focusedAssetId() !== null);

  /** True when the clipboard has contents and ≥1 asset is selected to paste onto. */
  readonly canPasteSettings = computed(
    () => this.clipboard.hasContents() && this.state.selectedCount() >= 1,
  );

  /** True when a focused asset exists and ≥2 assets are selected (sync needs
   * at least one OTHER asset besides the focused source). */
  readonly canSyncSettings = computed(
    () => this.state.focusedAssetId() !== null && this.state.selectedCount() >= 2,
  );

  /** Clipboard source's filename, for the selective-paste dialog header. */
  readonly clipboardSourceLabel = computed(() => this.clipboard.entry()?.sourceLabel ?? '');

  constructor() {
    // ── URL (slug:relPath) → selection ─────────────────────────────────────
    // M2: read the MapleAddress from :slug + ** wildcard segments. With
    // paramsInheritanceStrategy:'always', :slug is inherited by the ** child
    // route so paramMap.get('slug') works here. We also subscribe to
    // route.url (which emits when the wildcard segments change) so that
    // navigating within the same library (same slug, different relPath) re-
    // triggers the address resolution.
    const applyRouteAddress = (slug: string): void => {
      // route.snapshot.url contains ONLY the wildcard (child) segments — no
      // leading slug segment — because :slug lives on the parent route.
      const segments = this.route.snapshot.url.map((s) => s.path);
      const addr = routeSegmentsToAddress(slug, segments);
      const addrStr = formatAddress(addr);
      if (this.state.selectedSourceId() === addrStr) return;
      this.state.openSelfHostedSubfolder(addr.relPath, addrStr);
    };

    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((pm) => {
      const slug = pm.get('slug');
      if (!slug) return;
      applyRouteAddress(slug);
    });

    // Re-fire when wildcard segments change (intra-library folder navigation).
    this.route.url.pipe(takeUntilDestroyed()).subscribe(() => {
      const slug = this.route.snapshot.paramMap.get('slug');
      if (!slug) return;
      applyRouteAddress(slug);
    });

    // ── Selection → URL + localStorage ──────────────────────────────────────
    // Mirror every address change back into the path-based URL.
    effect(() => {
      const id = this.state.selectedSourceId();
      if (!id || !id.includes(':')) return;
      try {
        const addr = parseAddress(id);
        TypedStorage.setRaw(LAST_SOURCE_KEY, id);
        const segments = addressToRouteSegments(addr, 'browse');
        void this.router.navigate(segments);
      } catch {
        // Legacy id or unparseable — ignore.
      }
    });
  }

  // ── Copy / paste / sync develop settings (#944) ───────────────────────────

  /** Copy the focused asset's full develop settings into the app clipboard. */
  onCopySettings(): void {
    const id = this.state.focusedAssetId();
    if (id == null) return;
    const label = this.state.focusedAsset()?.filename ?? id;
    const model = this.state.adjustmentFor(id)();
    this.clipboard.copyFrom(id, label, model);
  }

  /** Paste every clipboard group onto every selected asset. */
  onPasteSettings(): void {
    this._pasteToSelection(ALL_ADJUSTMENT_GROUP_IDS);
  }

  onOpenPasteDialog(): void {
    if (!this.clipboard.hasContents()) return;
    this.pasteDialogVisible.set(true);
  }

  onPasteDialogDismiss(): void {
    this.pasteDialogVisible.set(false);
  }

  onPasteDialogConfirm(groups: readonly AdjustmentGroupId[]): void {
    this._pasteToSelection(groups);
    this.pasteDialogVisible.set(false);
  }

  /**
   * Apply the focused asset's own current settings across the rest of the
   * multi-selection — no prior copy step. Writes to `selection minus
   * focused` only; the source asset is never re-written.
   */
  onSyncSettings(): void {
    const focusedId = this.state.focusedAssetId();
    if (focusedId == null) return;
    const model = this.state.adjustmentFor(focusedId)();
    const patch = buildGroupPatch(model, ALL_ADJUSTMENT_GROUP_IDS);
    if (Object.keys(patch).length === 0) return;
    for (const id of this.state.selectedAssetIds()) {
      if (id === focusedId) continue;
      this.state.updateAdjustment(id, patch);
    }
  }

  /** Build the clipboard's group patch and write it onto every currently
   * selected asset — the shared tail of "paste all" and selective paste. */
  private _pasteToSelection(groups: readonly AdjustmentGroupId[]): void {
    const entry = this.clipboard.entry();
    if (!entry) return;
    const patch = buildGroupPatch(entry.model, groups);
    if (Object.keys(patch).length === 0) return;
    for (const id of this.state.selectedAssetIds()) {
      this.state.updateAdjustment(id, patch);
    }
  }

  // ── Page unload — flush pending XMP writes ───────────────────────────────
  @HostListener('window:beforeunload')
  onBeforeUnload(): void {
    void this.state.flushPendingXmpWrites();
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // A verbatim `browse-shell-keyboard.ts` extraction (matching
  // editor-shell-keyboard.ts / preview-shell-keyboard.ts) was tried here and
  // reverted: fallow's changed-vs-base attribution has no way to recognize a
  // byte-for-byte moved function as "pre-existing" — a brand-new file makes
  // its contents 100% "introduced", which flips this CRITICAL finding (and
  // several duplication findings against the structurally-similar
  // editor-shell-keyboard.ts) from gate-exempt (inherited) to gate-failing
  // (introduced), i.e. strictly worse than leaving it in place. This handler
  // predates the #2280 responsive slice and its complexity is pre-existing
  // and out of scope for this PR — see fallow-audit-web findings on PR #2293.
  @HostListener('document:keydown', ['$event'])
  // fallow-ignore-next-line complexity
  onKeydown(e: KeyboardEvent): void {
    // Skip when focus is in a text input or textarea.
    const target = e.target as HTMLElement;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable
    )
      return;

    // Escape: exit Select mode without touching the selection (#2404) — the
    // batch-metadata / pano / paste pills stay enabled off selectedCount(),
    // so this only leaves the toggle-on-click behaviour, not the selection.
    if (e.key === 'Escape' && this.state.isSelecting()) {
      this.state.exitSelectMode();
      e.preventDefault();
      return;
    }

    const fid = this.state.focusedAssetId();

    // 1–5: star rating
    if (['1', '2', '3', '4', '5'].includes(e.key) && fid) {
      this.state.setRating(fid, Number(e.key));
      e.preventDefault();
      return;
    }

    // 0: clear rating
    if (e.key === '0' && fid) {
      this.state.setRating(fid, 0);
      e.preventDefault();
      return;
    }

    // P: pick
    if ((e.key === 'p' || e.key === 'P') && fid) {
      const asset = this.state.focusedAsset();
      if (asset) {
        this.state.setFlag(fid, asset.flag === 'pick' ? 'unflagged' : 'pick');
      }
      e.preventDefault();
      return;
    }

    // X: reject
    if ((e.key === 'x' || e.key === 'X') && fid) {
      const asset = this.state.focusedAsset();
      if (asset) {
        this.state.setFlag(fid, asset.flag === 'reject' ? 'unflagged' : 'reject');
      }
      e.preventDefault();
      return;
    }

    // U: clear flag
    if ((e.key === 'u' || e.key === 'U') && fid) {
      this.state.setFlag(fid, 'unflagged');
      e.preventDefault();
      return;
    }

    // Arrow keys: navigate grid
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      this.state.focusNext();
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      this.state.focusPrev();
      e.preventDefault();
      return;
    }

    // ⌘⌥S / Ctrl+Alt+S — toggle sidebar
    if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 's' || e.key === 'S')) {
      this.state.toggleSidebar();
      e.preventDefault();
      return;
    }

    // Copy / paste / selective-paste develop settings (#944). Checked in
    // this order so ⌘⇧V (selective) doesn't also fire the bare ⌘V branch.
    // Suppressed while the selective-paste dialog is up so ⌘V can't fire a
    // full paste behind the open dialog.
    const meta = (e.metaKey || e.ctrlKey) && !this.pasteDialogVisible();
    if (meta && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      this.onCopySettings();
      e.preventDefault();
      return;
    }
    if (meta && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      this.onOpenPasteDialog();
      e.preventDefault();
      return;
    }
    if (meta && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      this.onPasteSettings();
      e.preventDefault();
      return;
    }

    // Enter on focused asset — navigate to Preview
    if (e.key === 'Enter' && fid) {
      void this.router.navigate(viewRouteCommands(fid));
      e.preventDefault();
      return;
    }
  }
}
