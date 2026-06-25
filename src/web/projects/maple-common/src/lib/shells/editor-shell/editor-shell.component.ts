// EditorShell — canvas-first layered editor (#1535, Pro Editor M1).
//
// Full-bleed <image-canvas> at the back; all chrome floats above.
// Responsive breakpoints:
//   <768px (phone):     top glass bar + bottom control card; no tool dock
//   768–1100px (tablet): top bar + right vertical tool dock + control card
//   ≥1100px (desktop):  same as tablet + hover affordances, no auto-recede
//
// All routing / address-resolution logic is preserved verbatim from the
// previous 3-column shell — only the layout / chrome layer changed.
//
// Canvas scrub: horizontal drag at fit-zoom moves the armed tool at 0.5:1.
// Chrome recede: dims to 30% after 3s idle; restores on pointer move (180ms).
// Desktop opts out of auto-recede.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { LibraryStateService } from '../../state/library-state.service';
import type { Asset, AssetId } from '../../models/asset';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { FilmstripComponent } from '../../components/filmstrip/filmstrip.component';
import { ImageCanvasComponent } from '../../components/image-canvas/image-canvas.component';
import { ImageCanvasService } from '../../components/image-canvas/image-canvas.service';
import { HistogramComponent } from '../../components/scopes/histogram.component';
import { EditorStateService } from '../../editor/editor-state.service';
import { ControlCardComponent } from '../../components/editor/control-card.component';
import { ToolDockComponent } from '../../components/editor/tool-dock.component';
import { MaskChipComponent } from '../../components/editor/mask-chip.component';
import { ValueHudComponent } from '../../components/editor/value-hud.component';
import { getPersistedFile } from '../../folder-access/file-cache';
import { formatAddress } from '../../addressing/maple-address';
import { routeSegmentsToAddress, editRouteCommands } from '../../addressing/route-address';
import {
  type ToolGroup,
  TOOL_GROUP_DISPLAY,
  TOOL_DISPLAY,
  displayRange,
} from '../../editor/tool-model';

/** Chrome visibility states driven by idle timer + scrub. */
type ChromeState = 'full' | 'receded' | 'scrubbing';

/** Idle timeout before chrome recedes (ms). Desktop: never recedes. */
const RECEDE_IDLE_MS = 3000;

@Component({
  selector: 'editor-shell',
  standalone: true,
  imports: [
    MapleIconComponent,
    FilmstripComponent,
    ImageCanvasComponent,
    HistogramComponent,
    ControlCardComponent,
    ToolDockComponent,
    MaskChipComponent,
    ValueHudComponent,
  ],
  styleUrl: './editor-shell.component.scss',
  templateUrl: './editor-shell.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pro-editor-shell' },
})
export class EditorShellComponent implements OnInit, AfterViewInit, OnDestroy {
  state = inject(LibraryStateService);
  canvasSvc = inject(ImageCanvasService);
  editorState = inject(EditorStateService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private ngZone = inject(NgZone);

  @ViewChild('canvasWrap') canvasWrapRef?: ElementRef<HTMLElement>;
  @ViewChild(ControlCardComponent) controlCard?: ControlCardComponent;

  // ── Route subscription (preserved) ────────────────────────────────────
  constructor() {
    this.route.url.pipe(takeUntilDestroyed()).subscribe(() => {
      this.applyRouteAddress();
    });

    // Bind EditorStateService to the focused asset so canvas scrub
    // (commit + setArmedInternalValue) and Shift+Arrow nudges operate
    // on the correct asset id (#1537 review — was always null).
    effect(() => {
      const id = this.state.focusedAssetId();
      if (id != null) {
        this.editorState.bind(id);
      }
    });
  }

  // ── Page unload (preserved) ────────────────────────────────────────────
  @HostListener('window:beforeunload')
  onBeforeUnload(): void {
    void this.state.flushPendingXmpWrites();
  }

  // ── Derived state (preserved) ─────────────────────────────────────────
  hasMultiplePhotos = computed(() => this.state.assetsInSelectedFolder().length > 1);

  // ── Pro editor state ──────────────────────────────────────────────────

  /** Currently active tool group (mirrors EditorStateService). */
  readonly activeGroup = computed<ToolGroup>(() => this.editorState.armedGroup());

  /** True when the viewport is tablet/desktop (≥768px). */
  readonly isTabletPlus = signal<boolean>(false);
  /** True when the viewport is desktop (≥1100px). Desktop opts out of recede. */
  readonly isDesktop = signal<boolean>(false);

  // Chrome recede
  readonly chromeState = signal<ChromeState>('full');
  private _recedeTimer: ReturnType<typeof setTimeout> | null = null;

  // Canvas scrub
  readonly scrubbing = signal<boolean>(false);
  private _scrubStartX = 0;
  private _scrubStartInternal = 0;
  private _scrubBound: ((e: PointerEvent) => void) | null = null;
  private _scrubUpBound: ((e: PointerEvent) => void) | null = null;
  private _scrubCancelBound: ((e: PointerEvent) => void) | null = null;

  // HUD state
  readonly hudVisible = signal<boolean>(false);
  readonly hudEyebrow = computed<string>(() => {
    const g = this.editorState.armedGroup();
    const t = this.editorState.armedTool();
    return `${TOOL_GROUP_DISPLAY[g]} · ${TOOL_DISPLAY[t]}`;
  });
  readonly hudValueText = computed<string>(() => {
    const v = this.editorState.armedDisplayValue();
    const tool = this.editorState.armedTool();
    const r = displayRange(tool);
    if (!r) return String(Math.round(v));
    const step = r[1] <= 4 ? 0.01 : 1;
    const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    const formatted = v.toFixed(decimals);
    return v > 0 ? `+${formatted}` : formatted;
  });
  readonly hudProgress = computed<number>(() => {
    const v = this.editorState.armedInternalValue(); // [-100, +100]
    return (v + 100) / 200; // map to [0, 1]
  });

  private _hudFadeTimer: ReturnType<typeof setTimeout> | null = null;

  private _ro?: ResizeObserver;
  private _pointerMoveBound: ((e: PointerEvent) => void) | null = null;

  ngOnInit(): void {
    this.applyRouteAddress();
    this._setupResponsive();
  }

  ngAfterViewInit(): void {
    this._setupPointerMove();
  }

  ngOnDestroy(): void {
    this._clearRecedeTimer();
    this._clearHudTimer();
    this._ro?.disconnect();
    this._cleanupScrub();
    if (this._pointerMoveBound) {
      document.removeEventListener('pointermove', this._pointerMoveBound);
      this._pointerMoveBound = null;
    }
  }

  // ── Outside-zone pointermove ──────────────────────────────────────────

  private _setupPointerMove(): void {
    if (typeof document === 'undefined') return;
    this._pointerMoveBound = (_e: PointerEvent) => {
      // Only re-enter the zone when we need to flip chromeState back to full
      // (i.e. currently receded and not on desktop). Idle-restart always runs.
      if (this.isDesktop()) return;
      if (this.scrubbing()) return;
      if (this.chromeState() === 'receded') {
        this.ngZone.run(() => {
          this.chromeState.set('full');
          this._restartRecedeTimer();
        });
      } else {
        // Already full — just restart the timer without a zone re-entry
        // (setTimeout is not tracked by Angular, so this is fine outside).
        this._restartRecedeTimer();
      }
    };
    this.ngZone.runOutsideAngular(() => {
      document.addEventListener('pointermove', this._pointerMoveBound!);
    });
  }

  // ── Responsive observer ───────────────────────────────────────────────

  private _setupResponsive(): void {
    if (typeof window === 'undefined') return;
    const update = () => {
      const w = window.innerWidth;
      const wasDesktop = this.isDesktop();
      this.isTabletPlus.set(w >= 768);
      this.isDesktop.set(w >= 1100);
      if (w >= 1100) {
        // Desktop opts out of auto-recede — always full
        this._clearRecedeTimer();
        this.chromeState.set('full');
      } else if (wasDesktop) {
        // Crossed back below the desktop breakpoint: restart the idle
        // recede timer so chrome auto-recedes again on phone/tablet.
        this.chromeState.set('full');
        this._restartRecedeTimer();
      }
    };
    this._ro = new ResizeObserver(update);
    this._ro.observe(document.documentElement);
    update();
    // On initial phone/tablet load the idle recede timer must start even if
    // the user never moves the pointer or resizes (the resize handler only
    // (re)starts it when crossing back from desktop). Desktop opts out.
    if (!this.isDesktop()) {
      this.chromeState.set('full');
      this._restartRecedeTimer();
    }
  }

  // ── Chrome recede ─────────────────────────────────────────────────────

  private _restartRecedeTimer(): void {
    this._clearRecedeTimer();
    if (this.isDesktop()) return;
    this._recedeTimer = setTimeout(() => {
      if (!this.scrubbing()) {
        this.chromeState.set('receded');
      }
    }, RECEDE_IDLE_MS);
  }

  private _clearRecedeTimer(): void {
    if (this._recedeTimer !== null) {
      clearTimeout(this._recedeTimer);
      this._recedeTimer = null;
    }
  }

  // ── Canvas scrub ──────────────────────────────────────────────────────

  onCanvasPointerDown(e: PointerEvent): void {
    // Only scrub at fit zoom (pixelScale === 0), primary button only
    if (e.button !== 0) return;
    if (this.canvasSvc.pixelScale() !== 0) return;
    if (!this.editorState.armedToolAcceptsValueEdits()) return;

    const wrap = this.canvasWrapRef?.nativeElement;
    if (!wrap) return;

    e.preventDefault();
    this._scrubStartX = e.clientX;
    this._scrubStartInternal = this.editorState.armedInternalValue();

    this.editorState.commit();
    this.scrubbing.set(true);
    this.chromeState.set('scrubbing');
    this._showHud();

    this._scrubBound = (ev: PointerEvent) => this._onScrubMove(ev);
    this._scrubUpBound = (ev: PointerEvent) => this._onScrubUp(ev);
    this._scrubCancelBound = (_ev: PointerEvent) => this._onScrubCancel();
    window.addEventListener('pointermove', this._scrubBound);
    window.addEventListener('pointerup', this._scrubUpBound);
    window.addEventListener('pointercancel', this._scrubCancelBound);
    wrap.setPointerCapture(e.pointerId);
  }

  private _onScrubMove(e: PointerEvent): void {
    const wrap = this.canvasWrapRef?.nativeElement;
    if (!wrap) return;
    const wrapW = wrap.clientWidth;
    if (wrapW <= 0) return;

    // 0.5:1 sensitivity: 2× canvas width = ±100 internal
    const dx = e.clientX - this._scrubStartX;
    const delta = (dx / wrapW) * 100;
    const raw = this._scrubStartInternal + delta * 0.5;
    const clamped = Math.min(100, Math.max(-100, raw));
    this.editorState.setArmedInternalValue(clamped);
    this._showHud();
  }

  private _onScrubUp(_e: PointerEvent): void {
    this._cleanupScrub();
    this._scheduleHudFade();
    this.chromeState.set('full');
    this._restartRecedeTimer();
  }

  /** pointercancel (e.g. stylus removed, browser-interrupted gesture):
   * mirror pointerup cleanup but do NOT commit the interrupted value —
   * just restore chrome state and release the listeners. */
  private _onScrubCancel(): void {
    this._cleanupScrub();
    this.hudVisible.set(false);
    this.chromeState.set('full');
    this._restartRecedeTimer();
  }

  private _cleanupScrub(): void {
    this.scrubbing.set(false);
    if (this._scrubBound) {
      window.removeEventListener('pointermove', this._scrubBound);
      this._scrubBound = null;
    }
    if (this._scrubUpBound) {
      window.removeEventListener('pointerup', this._scrubUpBound);
      this._scrubUpBound = null;
    }
    if (this._scrubCancelBound) {
      window.removeEventListener('pointercancel', this._scrubCancelBound);
      this._scrubCancelBound = null;
    }
  }

  // ── HUD ───────────────────────────────────────────────────────────────

  private _showHud(): void {
    this._clearHudTimer();
    this.hudVisible.set(true);
  }

  private _scheduleHudFade(): void {
    this._clearHudTimer();
    this._hudFadeTimer = setTimeout(() => {
      this.hudVisible.set(false);
    }, 600);
  }

  private _clearHudTimer(): void {
    if (this._hudFadeTimer !== null) {
      clearTimeout(this._hudFadeTimer);
      this._hudFadeTimer = null;
    }
  }

  // ── Group switching ───────────────────────────────────────────────────

  onGroupChange(group: ToolGroup): void {
    this.editorState.armGroup(group);
    this.editorState.haptic('switch');
  }

  // ── Current adjustment (for histogram) ────────────────────────────────
  readonly currentAdj = computed(() => {
    const id = this.state.focusedAssetId();
    if (!id) return null;
    return this.state.adjustmentFor(id)();
  });

  // ── Asset name ────────────────────────────────────────────────────────
  readonly assetName = computed<string>(() => {
    const a = this.state.focusedAsset();
    if (!a) return '';
    const parts = a.filename.split('/');
    return parts[parts.length - 1] ?? a.filename;
  });

  // ── Navigation helpers (preserved) ────────────────────────────────────

  goBack(): void {
    void this.router.navigate(['/browse']);
  }

  // ── Route address resolution (preserved verbatim) ─────────────────────

  private applyRouteAddress(): void {
    const slug = this.route.snapshot.paramMap.get('slug');
    if (slug) {
      if (this.state.backend === 'self-hosted' && slug.startsWith('fs:')) {
        const synth = this.state.hydrateSelfHostedFsAsset(slug as AssetId);
        if (synth?.absPath) {
          this.state.selectAsset(synth.id);
          this.openHydratedFsParent(synth);
          return;
        }
      }
      const segments = this.route.snapshot.url.map((s) => s.path);
      const addr = routeSegmentsToAddress(slug, segments);
      const addrStr = formatAddress(addr);
      const assets = this.state.assets();
      const target = assets.find((a) => a.id === addrStr);
      if (target) {
        this.state.selectAsset(target.id);
        return;
      }
      if (this.state.backend === 'self-hosted') {
        const synth = this.state.hydrateSelfHostedFsAsset(addrStr as AssetId);
        if (synth?.absPath) {
          this.state.selectAsset(synth.id);
          this.openHydratedFsParent(synth);
          return;
        }
      }
      const filename = addr.relPath.split('/').pop() ?? addrStr;
      void this.hydrateFromCache(filename);
      return;
    }

    const id = this.route.snapshot.paramMap.get('id');
    if (!id) return;

    const assets = this.state.assets();
    const target =
      id === 'first' ? this.state.assetsInSelectedFolder()[0] : assets.find((a) => a.id === id);

    if (target) {
      this.state.selectAsset(target.id);
      return;
    }

    if (this.state.backend === 'self-hosted' && id.startsWith('fs:')) {
      const synth = this.state.hydrateSelfHostedFsAsset(id as AssetId);
      if (synth?.absPath) {
        this.state.selectAsset(synth.id);
        this.openHydratedFsParent(synth);
        return;
      }
    }

    if (assets.length > 0) {
      this.state.selectAsset(assets[0].id);
      return;
    }

    void this.hydrateFromCache(id);
  }

  private openHydratedFsParent(synth: Asset): void {
    if (synth.id.startsWith('fs:') || !synth.absPath) return;
    const lastSlash = synth.absPath.lastIndexOf('/');
    if (lastSlash < 0) return;
    const parentDir = lastSlash === 0 ? '/' : synth.absPath.slice(0, lastSlash);
    this.state.openSelfHostedSubfolder(parentDir, synth.folderId, synth.id);
  }

  private async hydrateFromCache(id: string): Promise<void> {
    if (id === 'first') return;
    try {
      const record = await getPersistedFile(id);
      if (!record) {
        void this.router.navigate(['/']);
        return;
      }
      const bytes = new Uint8Array(await record.file.arrayBuffer());
      this.state.addImportedAsset(bytes, record.filename, id);
      this.state.selectedSourceId.set('f-imported');
      this.state.selectAsset(id);
    } catch (err) {
      console.error('EditorShell: hydrateFromCache failed', err);
      void this.router.navigate(['/']);
    }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable
    )
      return;

    const fid = this.state.focusedAssetId();

    // Esc — back to browse
    if (e.key === 'Escape') {
      this.goBack();
      e.preventDefault();
      return;
    }

    // Arrow navigation / slider nudge (Pro spec §13):
    //   ← / →             (bare)       — navigate prev / next image
    //   Shift + ← / →                  — nudge armed slider ±10
    //
    // The two behaviors are mutually exclusive by modifier key, so there
    // is no ambiguity and no dead code path.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.metaKey && !e.ctrlKey) {
      if (e.shiftKey) {
        // Shift+Arrow — nudge the armed slider ±10 internal units
        if (this.editorState.armedToolAcceptsValueEdits()) {
          const dir = e.key === 'ArrowLeft' ? -1 : 1;
          const cur = this.editorState.armedInternalValue();
          const next = Math.min(100, Math.max(-100, cur + dir * 10));
          this.editorState.commit();
          this.editorState.setArmedInternalValue(next);
        }
      } else {
        // Bare Arrow — navigate prev / next
        if (fid) {
          if (e.key === 'ArrowLeft') {
            const prev = this.state.peekPrev(fid);
            if (prev) {
              this.state.selectAsset(prev);
              void this.router.navigate(editRouteCommands(prev));
            }
          } else {
            const next = this.state.peekNext(fid);
            if (next) {
              this.state.selectAsset(next);
              void this.router.navigate(editRouteCommands(next));
            }
          }
        }
      }
      e.preventDefault();
      return;
    }

    const meta = e.metaKey || e.ctrlKey;

    // 1–4: switch tool group (bare, no meta)
    if (!meta && ['1', '2', '3', '4'].includes(e.key)) {
      const groups: ToolGroup[] = ['light', 'color', 'effects', 'detail'];
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < groups.length) {
        this.onGroupChange(groups[idx]);
        e.preventDefault();
        return;
      }
    }

    // 5: star rating
    if (!meta && e.key === '5' && fid) {
      this.state.setRating(fid, 5);
      e.preventDefault();
      return;
    }

    // 0: clear rating
    if (!meta && e.key === '0' && fid) {
      this.state.setRating(fid, 0);
      e.preventDefault();
      return;
    }

    // P: pick
    if ((e.key === 'p' || e.key === 'P') && fid) {
      const asset = this.state.focusedAsset();
      if (asset) this.state.setFlag(fid, asset.flag === 'pick' ? 'unflagged' : 'pick');
      e.preventDefault();
      return;
    }

    // X: reject
    if ((e.key === 'x' || e.key === 'X') && fid) {
      const asset = this.state.focusedAsset();
      if (asset) this.state.setFlag(fid, asset.flag === 'reject' ? 'unflagged' : 'reject');
      e.preventDefault();
      return;
    }

    // U: clear flag
    if ((e.key === 'u' || e.key === 'U') && fid) {
      this.state.setFlag(fid, 'unflagged');
      e.preventDefault();
      return;
    }

    // \ or b: toggle before/after
    if (e.key === '\\' || e.key === 'b' || e.key === 'B') {
      this.canvasSvc.toggleBeforeAfter();
      e.preventDefault();
      return;
    }

    // R: reset armed group — delegates to ControlCard which owns group state
    if ((e.key === 'r' || e.key === 'R') && !meta) {
      this.controlCard?.resetGroup();
      e.preventDefault();
      return;
    }

    // F: fit
    if ((e.key === 'f' || e.key === 'F') && !meta) {
      this.canvasSvc.zoomToFit();
      e.preventDefault();
      return;
    }

    // Z: 1:1
    if ((e.key === 'z' || e.key === 'Z') && !meta) {
      this.canvasSvc.zoomTo100();
      e.preventDefault();
      return;
    }

    // ⌘⌥S / Ctrl+Alt+S — toggle sidebar/filmstrip
    if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 's' || e.key === 'S')) {
      this.state.toggleSidebar();
      e.preventDefault();
      return;
    }

    // ⌘⌥D / Ctrl+Alt+D — toggle inspector
    if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 'd' || e.key === 'D')) {
      this.state.toggleInspector();
      e.preventDefault();
      return;
    }
  }
}
