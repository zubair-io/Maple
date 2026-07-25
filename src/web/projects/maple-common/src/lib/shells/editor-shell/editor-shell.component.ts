// EditorShell — canvas-first layered editor (#1535, Pro Editor M1).
//
// Full-bleed <image-canvas> at the back; all chrome floats above.
// Responsive breakpoints:
//   <768px (phone):      top glass bar + bottom horizontal tool dock +
//                        closeable flyout control card (#1807 phone CARD)
//   768–1100px (tablet): top bar + right vertical tool dock + control card
//   ≥1100px (desktop):  same as tablet + hover affordances, no auto-recede
//
// All routing / address-resolution logic is preserved verbatim from the
// previous 3-column shell — only the layout / chrome layer changed.
//
// Curve panel: glass card that opens/closes via the Curve dock entry (#1540).
// Tablet/desktop anchors to the dock column; phone floats above the bottom
// dock (`onPhoneCurvePanelToggle`).
// Crop panel: glass card that opens while the Crop dock entry is armed
// (#1813) — hosts the shared `CropToolbarComponent`/`CropSessionService` also
// used by the S5 editor (`EditorComponent`, #638), so a crop commits through
// the identical AdjustmentModel.crop path on both editors. The interactive
// crop rectangle is the shared `CropOverlayComponent`, already mounted
// inside `ImageCanvasComponent` (which both editors embed) and gated on
// `CropSessionService.active` — no per-editor overlay wiring needed. Wired on
// phone too (`onPhoneToolChange`) — the phone dock's Crop entry shipped
// disabled in #1811 pending this landing, and is now enabled.
// Presets panel: glass card that opens/closes via the Presets dock entry
// (#1815) — hosts the shared `PresetsPanelComponent`, also used by the S5
// editor (#1115), so apply/save/delete route through the identical
// `PresetsService` / `EditorStateService.applyPreset` path on both editors.
// HSL panel: glass card that opens while the HSL dock entry is armed (epic
// #1807 slice 4) — hosts the shared `SubParamRowComponent` (chip selector)
// + `DragBarComponent` + `ValueChipComponent`, the same generic multi-param
// (tool, subParam) arming machinery the S5 editor's HSL pill uses (#1112),
// so a hue/sat/lum edit writes the identical `AdjustmentModel` field on both
// editors. HSL has no single primary drag-bar field (24 sub-params across
// 3 rows), so — like Crop — it does not appear in the control card's living-
// slider grid; the control card hides entirely while HSL is armed.
// Presets, Curve, Crop, and HSL all share the same panel anchor and are
// mutually exclusive (see `onPresetsPanelToggle`/`onCurvePanelToggle`/
// `onToolChange`) — the phone equivalents (`onPhone*`) close the flyout
// control card first, then delegate to the same shared handler, so the
// exclusion holds identically on phone.
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
import type { AssetId } from '../../models/asset';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { FilmstripComponent } from '../../components/filmstrip/filmstrip.component';
import { ImageCanvasComponent } from '../../components/image-canvas/image-canvas.component';
import { ImageCanvasService } from '../../components/image-canvas/image-canvas.service';
import { HistogramComponent } from '../../components/scopes/histogram.component';
import { EditorStateService } from '../../editor/editor-state.service';
import { ControlCardComponent } from '../../components/editor/control-card.component';
import { ToolDockComponent } from '../../components/editor/tool-dock.component';
import { ValueHudComponent } from '../../components/editor/value-hud.component';
import { ToneCurveComponent } from '../../components/develop/tone-curve.component';
import { WbPadComponent } from '../../components/develop/wb-pad.component';
import { CropToolbarComponent } from '../../editor/crop-toolbar.component';
import { PresetsPanelComponent } from '../../editor/presets/presets-panel.component';
import { SubParamRowComponent } from '../../editor/sub-param-row.component';
import { DragBarComponent } from '../../editor/drag-bar.component';
import { ValueChipComponent } from '../../editor/value-chip.component';
import { InfoPanelComponent } from '../../info/info-panel.component';
import { BottomSheetComponent } from '../bottom-sheet.component';
import { ExportDialogComponent } from '../../export/export-dialog.component';
import { TabBarVisibilityService } from '../tab-bar-visibility.service';
import { editRouteCommands, viewRouteCommands } from '../../addressing/route-address';
import { applyRouteAddress as applyEditorRouteAddress } from './editor-shell-route';
import { handleEditorKeydown } from './editor-shell-keyboard';
import {
  type ChromeRecedeState,
  newChromeRecedeState,
  setupPointerMove,
  setupResponsive,
  teardownPointerMove,
  clearRecedeTimer,
  restartRecedeTimer as chromeRestartRecedeTimer,
} from './editor-shell-chrome';
import {
  type ScrubGestureState,
  newScrubGestureState,
  onCanvasPointerDown as scrubOnCanvasPointerDown,
  cleanupScrub,
} from './editor-shell-scrub';
import {
  type ToolGroup,
  type ToolId,
  TOOL_GROUP_DISPLAY,
  TOOL_DISPLAY,
  displayRange,
} from '../../editor/tool-model';

/** Chrome visibility states driven by idle timer + scrub. */
type ChromeState = 'full' | 'receded' | 'scrubbing';

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
    ValueHudComponent,
    ToneCurveComponent,
    WbPadComponent,
    CropToolbarComponent,
    PresetsPanelComponent,
    SubParamRowComponent,
    DragBarComponent,
    ValueChipComponent,
    InfoPanelComponent,
    BottomSheetComponent,
    ExportDialogComponent,
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
  /** Public: read by `editor-shell-chrome.ts` (extracted to stay under the
   *  per-file LOC budget — see that module's header comment). */
  ngZone = inject(NgZone);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private tabBar = inject(TabBarVisibilityService);

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
    // Developed-preview persist (#2018) — same "flush on close" role as the
    // sidecar flush above, fire-and-forget for the same reason (beforeunload
    // can't reliably await async work).
    this.state.flushPendingPreviewWrites();
  }

  // ── Derived state (preserved) ─────────────────────────────────────────
  hasMultiplePhotos = computed(() => this.state.assetsInSelectedFolder().length > 1);

  // ── Pro editor state ──────────────────────────────────────────────────

  /** Currently active tool group (mirrors EditorStateService). */
  readonly activeGroup = computed<ToolGroup>(() => this.editorState.armedGroup());

  /** Currently armed tool (mirrors EditorStateService) — drives the dock's
   *  specific-tool highlight (Crop) and the crop-toolbar panel visibility. */
  readonly activeTool = computed<ToolId>(() => this.editorState.armedTool());

  /** True while the Crop tool is armed (#1813) — mounts the crop toolbar
   *  panel next to the dock. The interactive crop rectangle itself is drawn
   *  by `CropOverlayComponent`, already mounted inside `editor-image-canvas`
   *  (shared with the S5 editor) and gated on the same `CropSessionService`. */
  readonly cropArmed = computed<boolean>(() => this.editorState.armedTool() === 'crop');

  /** True while the HSL tool is armed (epic #1807 slice 4) — mounts the HSL
   *  panel (chip selector + drag bar + value chip) next to the dock, the
   *  same shared multi-param editing surface the S5 editor uses for its HSL
   *  pill (#1112). HSL has no canvas overlay of its own — unlike Crop, it
   *  only needs the panel. */
  readonly hslArmed = computed<boolean>(() => this.editorState.armedTool() === 'hsl');

  /** True when the viewport is tablet/desktop (≥768px). */
  readonly isTabletPlus = signal<boolean>(false);
  /** True when the viewport is desktop (≥1100px). Desktop opts out of recede. */
  readonly isDesktop = signal<boolean>(false);

  /** True when the curve panel (tone curve + WB pad) is open (#1540). */
  readonly curveOpen = signal<boolean>(false);

  /**
   * Phone only (#1807): whether the flyout control card is open above the
   * bottom horizontal dock. Tapping a dock group icon opens it (and arms
   * that group); tapping the active group's icon again, or the card's own
   * close button, closes it. Independent of `curveOpen`, which drives its
   * own floating curve panel.
   */
  readonly phoneCardOpen = signal<boolean>(false);

  /** True when the presets panel is open (#1815). Shares the same panel
   *  anchor as curve/crop — mutually exclusive with both (see
   *  `onPresetsPanelToggle`/`onCurvePanelToggle`/`onToolChange`). */
  readonly presetsOpen = signal<boolean>(false);

  /** True when the Info sheet/pane is open (epic #1807 slice 5). Bottom
   *  sheet on phone, right-side pane on tablet/desktop — same split
   *  `PreviewShellComponent` uses for its Info surface. Info has its own
   *  anchor (not the shared curve/crop/presets/HSL one), so it does not
   *  participate in that mutual-exclusion group. */
  readonly infoOpen = signal<boolean>(false);

  /** Export options dialog (#943) — modal, so it has no anchor to share. */
  readonly exportOpen = signal<boolean>(false);

  // Chrome recede (idle-timer/resize-observer/pointermove machinery lives in
  // editor-shell-chrome.ts, extracted to stay under the per-file LOC budget).
  readonly chromeState = signal<ChromeState>('full');
  private readonly _chrome: ChromeRecedeState = newChromeRecedeState();

  // Canvas scrub (gesture handlers live in editor-shell-scrub.ts, extracted
  // to stay under the per-file LOC budget).
  readonly scrubbing = signal<boolean>(false);
  private readonly _scrub: ScrubGestureState = newScrubGestureState();

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

  ngOnInit(): void {
    this.tabBar.hidden.set(true);
    this.applyRouteAddress();
    setupResponsive(this, this._chrome);
  }

  ngAfterViewInit(): void {
    setupPointerMove(this, this._chrome);
  }

  ngOnDestroy(): void {
    this.tabBar.hidden.set(false);
    clearRecedeTimer(this._chrome);
    this._clearHudTimer();
    this._chrome.resizeObserver?.disconnect();
    cleanupScrub(this, this._scrub);
    if (this._undoLongPressTimer) {
      clearTimeout(this._undoLongPressTimer);
      this._undoLongPressTimer = null;
    }
    teardownPointerMove(this._chrome);
    // Editor-teardown persist trigger (#2018): leaving the editor (SPA
    // navigation, not just a hard tab close) is one of the write policy's
    // three triggers — idle debounce, exit, navigate-away. The idle timer
    // itself lives on the singleton `EditPreviewPersistService`, so it
    // would still fire in the background even without this call; this makes
    // the "editor teardown" trigger immediate rather than waiting out
    // whatever's left of the debounce.
    this.state.flushPendingPreviewWrites();
  }

  // ── Canvas scrub ───────────────────────────────────────────────────────
  // Gesture handlers live in editor-shell-scrub.ts (extracted to stay under
  // the per-file LOC budget); `restartRecedeTimer`/`showHud`/`scheduleHudFade`
  // below are called back into from there via the public `shell` surface.

  onCanvasPointerDown(e: PointerEvent): void {
    scrubOnCanvasPointerDown(this, this._scrub, e);
  }

  /** Public: called back into from editor-shell-scrub.ts. */
  restartRecedeTimer(): void {
    chromeRestartRecedeTimer(this, this._chrome);
  }

  // ── HUD ───────────────────────────────────────────────────────────────
  // Public: called back into from editor-shell-scrub.ts.

  showHud(): void {
    this._clearHudTimer();
    this.hudVisible.set(true);
  }

  scheduleHudFade(): void {
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

  /** Arm a specific dock tool (Crop — #1813 — or HSL — epic #1807 slice 4).
   *  Matches the S5 editor's pill row (`ToolPillRowComponent.select`):
   *  tapping always arms; exiting crop is an explicit action (the crop
   *  toolbar's Done button), not a second tap on the dock entry — HSL has no
   *  such action and simply stays armed until another tool is picked. Crop,
   *  HSL, Curve, and Presets share the same panel anchor and are mutually
   *  exclusive — arming Crop or HSL closes the curve and presets panels so
   *  no two can ever render on top of each other (the newly-armed tool wins). */
  onToolChange(tool: ToolId): void {
    if (tool === 'crop' || tool === 'hsl') {
      this.curveOpen.set(false);
      this.presetsOpen.set(false);
    }
    this.editorState.armTool(tool);
    this.editorState.haptic('switch');
  }

  /** Toggle the curve panel. No-op while Crop or HSL is armed: both own the
   *  shared panel anchor, so Curve can't open over either. Opening Curve also
   *  closes Presets, since they share the same anchor too (the mutual-
   *  exclusion half that keeps the panels from overlapping — the other
   *  halves are `onToolChange` closing curve/presets when Crop/HSL arms, and
   *  `onPresetsPanelToggle` closing curve when Presets opens). */
  onCurvePanelToggle(): void {
    if (this.cropArmed() || this.hslArmed()) return;
    this.presetsOpen.set(false);
    this.curveOpen.update((v) => !v);
  }

  /**
   * Phone bottom dock (#1807): tapping a group icon arms that group and opens
   * the flyout card; tapping the already-active group's icon again closes it
   * (mirrors the mockup's "tap active icon to collapse" affordance). Only one
   * flyout (slider card or curve panel) is ever open at a time, since both
   * float in the same anchor slot above the dock.
   */
  onPhoneDockGroupChange(group: ToolGroup): void {
    if (this.phoneCardOpen() && !this.curveOpen() && group === this.activeGroup()) {
      this.closePhoneCard();
      return;
    }
    this.curveOpen.set(false);
    this.onGroupChange(group);
    this.phoneCardOpen.set(true);
  }

  /**
   * Phone bottom dock's Curve entry: toggles the curve panel, closing the
   * slider flyout card first so only one flyout is open at a time.
   */
  onPhoneCurvePanelToggle(): void {
    this.phoneCardOpen.set(false);
    this.onCurvePanelToggle();
  }

  /**
   * Phone bottom dock's Crop/HSL entries: arms the tool, closing the slider
   * flyout card first so only one flyout (card or crop/HSL panel) is open at
   * a time — same role `onPhoneDockGroupChange`/`onPhoneCurvePanelToggle`
   * play for groups/Curve.
   */
  onPhoneToolChange(tool: ToolId): void {
    this.phoneCardOpen.set(false);
    this.onToolChange(tool);
  }

  /**
   * Phone bottom dock's Presets entry: toggles the presets panel, closing
   * the slider flyout card first so only one flyout is open at a time.
   */
  onPhonePresetsPanelToggle(): void {
    this.phoneCardOpen.set(false);
    this.onPresetsPanelToggle();
  }

  closePhoneCard(): void {
    this.phoneCardOpen.set(false);
    this.editorState.haptic('switch');
  }

  /** Toggle the presets panel (#1815). No-op while Crop or HSL is armed, and
   *  closes Curve if open — same shared-anchor mutual exclusion as
   *  Curve/Crop/HSL. */
  onPresetsPanelToggle(): void {
    if (this.cropArmed() || this.hslArmed()) return;
    this.curveOpen.set(false);
    this.presetsOpen.update((v) => !v);
  }

  // ── Undo / redo (top bar) ──────────────────────────────────────────────
  // Long-press → redo, tap → undo. Mirrors the S5 editor's header button
  // (`editor-header.component.ts`) so both editors share the same gesture.
  private _undoLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  private _undoLongPressed = false;

  /** Captures the pointer on the button itself (#1816 review) so a drag-off
   *  release still delivers `pointerup` HERE rather than to whatever element
   *  is now under the pointer — without capture, a press-drag-release
   *  outside the button's bounds never fires `onUndoPointerUp`, so the
   *  long-press timer never clears and redo() fires despite the pointer
   *  having left the button. Guarded: not every pointer environment
   *  implements `setPointerCapture` (e.g. jsdom in tests). */
  onUndoPointerDown(e: PointerEvent): void {
    this._undoLongPressed = false;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    this._undoLongPressTimer = setTimeout(() => {
      this._undoLongPressed = true;
      this.editorState.redo();
    }, 500);
  }

  onUndoPointerUp(): void {
    if (this._undoLongPressTimer) {
      clearTimeout(this._undoLongPressTimer);
      this._undoLongPressTimer = null;
    }
    if (!this._undoLongPressed) this.editorState.undo();
  }

  onUndoPointerCancel(): void {
    if (this._undoLongPressTimer) {
      clearTimeout(this._undoLongPressTimer);
      this._undoLongPressTimer = null;
    }
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

  /** Back returns to Preview for the current asset (Preview → Edit → Back
   *  lands back where the user came from), matching the retired S5 editor's
   *  `EditorPageComponent.onDismiss()`. Falls back to Browse when there is no
   *  focused asset (e.g. deep-link into an editor route with nothing loaded). */
  goBack(): void {
    const id = this.state.focusedAssetId();
    void this.router.navigate(id ? viewRouteCommands(id) : ['/browse']);
  }

  /** Select an asset and deep-link the editor route to it (prev/next nav). */
  navigateToAsset(id: AssetId): void {
    this.state.selectAsset(id);
    void this.router.navigate(editRouteCommands(id));
  }

  // ── Route address resolution ──────────────────────────────────────────
  // Extracted verbatim to editor-shell-route.ts (per-file LOC budget — same
  // precedent as editor-shell-chrome.ts / editor-shell-scrub.ts).

  private applyRouteAddress(): void {
    applyEditorRouteAddress(this.route, this.state, this.router);
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    handleEditorKeydown(this, e);
  }
}
