// EditorShell — canvas-first layered editor (#1535, Pro Editor M1).
//
// Full-bleed <image-canvas> at the back; all chrome floats above.
// Responsive breakpoints (LayoutService — #2279):
//   <768px (phone):      top glass bar + always-visible slider card stacked
//                        above the bottom horizontal tool dock, Apple's
//                        MobileControlBar two-card layout (#1807 Task 5)
//   768–1024px (tablet): top bar + right vertical tool dock + control card
//   >1024px (desktop):  same as tablet + hover affordances, no auto-recede
//
// All routing / address-resolution logic is preserved verbatim from the
// previous 3-column shell — only the layout / chrome layer changed.
//
// Curve panel: glass card that opens/closes via the Curve dock entry (#1540).
// Tablet/desktop anchors to the dock column; phone floats above the bottom
// dock in the same anchor slot the always-visible slider card uses, so
// `onPhoneDockGroupChange` closes it (and Presets) when a group icon is
// tapped.
// Crop panel: glass card that opens while the Crop dock entry is armed
// (#1813) — hosts the shared `CropToolbarComponent`/`CropSessionService` also
// used by the S5 editor (`EditorComponent`, #638), so a crop commits through
// the identical AdjustmentModel.crop path on both editors. The interactive
// crop rectangle is the shared `CropOverlayComponent`, already mounted
// inside `ImageCanvasComponent` (which both editors embed) and gated on
// `CropSessionService.active` — no per-editor overlay wiring needed. Wired on
// phone too, straight through `onToolChange` (#1807 Task 5 retired the
// phone-specific `onPhoneToolChange` wrapper — closing the now-removed
// flyout was its only phone-specific behaviour).
// Presets panel: glass card that opens/closes via the Presets dock entry
// (#1815) — hosts the shared `PresetsPanelComponent`, also used by the S5
// editor (#1115), so apply/save/delete route through the identical
// `PresetsService` / `EditorStateService.applyPreset` path on both editors.
// HSL / B&W bodies (epic #1807 slice 4, #276): neither has a dock entry —
// both are reached from the Colour sub-tool row and render INSIDE the
// control card via content projection (`cardBodySubParam`), not in a
// dock-side panel of their own — hosting the shared `SubParamRowComponent` +
// `DragBarComponent` + `ValueChipComponent` multi-param surface the S5
// editor's HSL pill uses (#1112); B&W adds an explicit toggle for
// `model.blackWhite` (`onBlackWhiteToggle`, routed through
// `EditorStateService.setBlackWhite` for undo). HSL's sub-tool chip is
// hidden while Black & White is On (#276) — see `blackWhiteOn`/`bwMixArmed`
// below and `ControlCardComponent.subtools()`.
// Curve, Crop, Presets, and Noise share one dock-side panel anchor and are
// mutually exclusive there (`onPresetsPanelToggle`/`onCurvePanelToggle`/
// `onToolChange`); on phone the always-visible slider card floats in that
// same anchor slot too. HSL/bwMix/Color Grading project into the control
// card instead, so it's the card — not a dock-side panel — that must not
// collide with Curve/Presets/Noise/Crop/Info: the card hides while any of
// them is open (`.control-card-anchor`'s `@if` guard, Critical 1 review).
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
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { LibraryStateService } from '../../state/library-state.service';
import { LayoutService } from '../../layout-service';
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
import { ColorGradingPanelComponent } from '../../components/develop/color-grading-panel.component';
import { CropToolbarComponent } from '../../editor/crop-toolbar.component';
import { PresetsPanelComponent } from '../../editor/presets/presets-panel.component';
import { SubParamRowComponent } from '../../editor/sub-param-row.component';
import { DragBarComponent } from '../../editor/drag-bar.component';
import { ValueChipComponent } from '../../editor/value-chip.component';
import { InfoPanelComponent } from '../../info/info-panel.component';
import { BottomSheetComponent } from '../bottom-sheet.component';
import { ExportDialogComponent } from '../../export/export-dialog.component';
import { editRouteCommands, viewRouteCommands } from '../../addressing/route-address';
import { AdjustmentClipboardService } from '../../editor/copy-paste/adjustment-clipboard.service';
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
  type UndoLongPressState,
  newUndoLongPressState,
  onUndoPointerDown as undoOnPointerDown,
  onUndoPointerUp as undoOnPointerUp,
  onUndoPointerCancel as undoOnPointerCancel,
} from './editor-shell-undo';
import { type ToolGroup, type ToolId } from '../../editor/tool-model';
import { hudEyebrowText, hudValueLabel, hudProgressFraction } from './editor-shell-hud';

/** Chrome visibility states driven by idle timer + scrub. */
type ChromeState = 'full' | 'receded' | 'scrubbing';

@Component({
  selector: 'editor-shell',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    MapleIconComponent,
    FilmstripComponent,
    ImageCanvasComponent,
    HistogramComponent,
    ControlCardComponent,
    ToolDockComponent,
    ValueHudComponent,
    ToneCurveComponent,
    WbPadComponent,
    ColorGradingPanelComponent,
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
  /** Public: read by `editor-shell-keyboard.ts` (⌘C copies the open
   *  image's settings — see the extraction note above `handleEditorKeydown`). */
  clipboard = inject(AdjustmentClipboardService);
  /** Public: read by `editor-shell-chrome.ts` (extracted to stay under the
   *  per-file LOC budget — see that module's header comment). */
  ngZone = inject(NgZone);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private layoutService = inject(LayoutService);

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

    // Safety net (#276): if HSL is ever the armed tool while Black & White
    // is On — however that combination arose (a preset apply, undo/redo
    // landing on such a state, a race with the toggle click) — re-arm
    // bwMix. The HSL surface (dock entry + panel) is hidden while B&W is
    // On, so leaving `hsl` armed would point the drag bar / sub-param row
    // at a tool with no visible way to reach it.
    effect(() => {
      if (this.blackWhiteOn() && this.editorState.armedTool() === 'hsl') {
        this.editorState.armTool('bwMix');
      }
    });

    // Chrome-recede reaction to the breakpoint (web responsive foundation,
    // #2279). `isDesktop`/`isTabletPlus` are computed straight off the shared
    // LayoutService signal (above); this effect only reads `isDesktop()` and
    // manages the auto-recede idle timer + `chromeState` side-effects. It
    // writes `chromeState` (never a signal it reads), so it cannot self-
    // trigger, and it re-runs only on a desktop↔non-desktop crossing.
    effect(() => {
      setupResponsive(this, this._chrome);
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

  /** True while the Noise tool is armed (#1153) — mounts the SAME shared
   *  multi-param panel HSL uses, so the Noise pill's four tiers (Luminance,
   *  Color, Deep, Prefilter) are all reachable. The control card only
   *  projects a tool's PRIMARY field (`fieldFor`), so without this the two
   *  decode-product tiers would have no surface on web. Unlike HSL the
   *  control card stays mounted alongside: the card's Noise row is what
   *  arms the tool in the first place. */
  readonly noiseArmed = computed<boolean>(() => this.editorState.armedTool() === 'noise');

  /** True while the bwMix (Black & White) tool is armed (#276) — mounts the
   *  B&W panel (toggle + chip selector + drag bar + value chip), projected
   *  into `pro-control-card` via the `cardBodySubParam` slot (#1807 Task 4),
   *  the same shared multi-param editing surface as HSL. */
  readonly bwMixArmed = computed<boolean>(() => this.editorState.armedTool() === 'bwMix');

  /** True while Black & White is On for the focused asset (#276) — drives
   *  hiding the HSL sub-tool chip (`ControlCardComponent`'s `blackWhiteOn`
   *  input) and de-emphasising the B&W panel's 8 gray-mixer sliders when
   *  Off. */
  readonly blackWhiteOn = computed<boolean>(
    () => this.editorState.currentAdjustment()?.blackWhite === 'On',
  );

  /** True when LayoutService.layout() is tablet or desktop (≥768px). */
  readonly isTabletPlus = computed<boolean>(() => this.layoutService.layout() !== 'phone');
  /** True when LayoutService.layout() is desktop (>1024px). Desktop opts out of recede. */
  readonly isDesktop = computed<boolean>(() => this.layoutService.layout() === 'desktop');

  /** True when the curve panel (tone curve + WB pad) is open (#1540). */
  readonly curveOpen = signal<boolean>(false);

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
  readonly hudEyebrow = computed<string>(() =>
    hudEyebrowText(this.editorState.armedGroup(), this.editorState.armedTool()),
  );
  readonly hudValueText = computed<string>(() =>
    hudValueLabel(this.editorState.armedDisplayValue(), this.editorState.armedTool()),
  );
  readonly hudProgress = computed<number>(() =>
    hudProgressFraction(this.editorState.armedInternalValue()),
  );

  private _hudFadeTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.applyRouteAddress();
  }

  ngAfterViewInit(): void {
    setupPointerMove(this, this._chrome);
  }

  ngOnDestroy(): void {
    clearRecedeTimer(this._chrome);
    this._clearHudTimer();
    cleanupScrub(this, this._scrub);
    undoOnPointerCancel(this._undo);
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

  /** Arm a specific dock tool (Crop — #1813 — HSL — epic #1807 slice 4 —
   *  bwMix — #276 — or Color Grading — #275). Matches the S5 editor's pill
   *  row (`ToolPillRowComponent.select`): tapping always arms; exiting crop
   *  is an explicit action (the crop toolbar's Done button), not a second
   *  tap on the dock entry — HSL/bwMix/Color Grading have no such action
   *  and simply stay armed until another tool is picked. Crop owns the
   *  shared dock-side panel anchor Curve/Presets/Noise also use, so arming
   *  it closes both. HSL/bwMix/Color Grading don't share that anchor — they
   *  render inside the control card instead — but arming any of them still
   *  closes Curve/Presets too, because the card itself hides while either
   *  is open (Critical 1, `.control-card-anchor`'s `@if` guard); closing
   *  them here is what makes the card (and the tool just armed) visible
   *  again immediately, rather than leaving the user to close Curve/Presets
   *  by hand first. */
  onToolChange(tool: ToolId): void {
    if (tool === 'crop' || tool === 'hsl' || tool === 'bwMix' || tool === 'colorGrade') {
      this.curveOpen.set(false);
      this.presetsOpen.set(false);
    }
    this.editorState.armTool(tool);
    this.editorState.haptic('switch');
  }

  /** Toggle Black & White On/Off for the focused asset (#276) — the B&W
   *  panel's toggle control. Routed entirely through
   *  `EditorStateService.setBlackWhite`, which owns the commit/undo write
   *  and the HSL-armed re-arm safety net. */
  onBlackWhiteToggle(): void {
    this.editorState.setBlackWhite(this.blackWhiteOn() ? 'Off' : 'On');
  }

  /** Toggle the curve panel. No-op while Crop is armed: Crop owns the shared
   *  dock-side panel anchor with a full-replacement toolbar (no group
   *  sliders behind it), so Curve can't open over it. HSL, bwMix, and Color
   *  Grading no longer need to be in this guard (#1807 review, Critical 1):
   *  they render INSIDE the control card via content projection rather than
   *  owning the dock-side anchor, and the card itself now hides whenever
   *  Curve is open (`.control-card-anchor`'s `@if` guard in the template),
   *  so there is nothing left for Curve to open over. Opening Curve also
   *  closes Presets, since they share the same dock-side anchor too (the
   *  mutual-exclusion half that keeps the panels from overlapping — the
   *  other half is `onPresetsPanelToggle` closing curve when Presets
   *  opens). */
  onCurvePanelToggle(): void {
    if (this.cropArmed()) return;
    this.presetsOpen.set(false);
    this.curveOpen.update((v) => !v);
  }

  /**
   * Phone bottom dock (#1807 Task 5): arms the tapped group, closing an open
   * curve or presets panel first. The slider card is visible by default (no
   * closeable flyout) and the template hides it whenever `curveOpen()`,
   * `presetsOpen()`, or `noiseArmed()` is true — that `@if` guard is what
   * actually keeps the card and the curve/presets panel from rendering on
   * top of each other (they float in the same anchor slot above the dock,
   * unlike tablet/desktop where the curve/presets/noise panels live in the
   * separate `.tool-dock-anchor` column). This handler's own
   * `curveOpen.set(false)`/`presetsOpen.set(false)` close an already-open
   * panel so tapping a group tool brings the card back — `onGroupChange`
   * alone doesn't touch either signal, and Crop/HSL/bwMix/Color Grading
   * already get the same close via `onToolChange` (review round 2: a
   * group tap while Presets was open left `presetsOpen` true and the card
   * hidden underneath it, since only `curveOpen` was cleared here).
   */
  onPhoneDockGroupChange(group: ToolGroup): void {
    this.curveOpen.set(false);
    this.presetsOpen.set(false);
    this.onGroupChange(group);
  }

  /** Toggle the presets panel (#1815). No-op while Crop is armed, and closes
   *  Curve if open — same shared dock-side-anchor mutual exclusion as
   *  Curve/Crop. See `onCurvePanelToggle` for why HSL/bwMix/Color Grading
   *  dropped out of this guard (#1807 review, Critical 1). */
  onPresetsPanelToggle(): void {
    if (this.cropArmed()) return;
    this.curveOpen.set(false);
    this.presetsOpen.update((v) => !v);
  }

  // ── Undo / redo (top bar) ──────────────────────────────────────────────
  // Long-press → redo, tap → undo; gesture body in `editor-shell-undo.ts`
  // (file-size budget), same shape as the scrub and chrome extractions.
  private readonly _undo: UndoLongPressState = newUndoLongPressState();

  onUndoPointerDown(e: PointerEvent): void {
    undoOnPointerDown(this, this._undo, e);
  }

  onUndoPointerUp(): void {
    undoOnPointerUp(this, this._undo);
  }

  onUndoPointerCancel(): void {
    undoOnPointerCancel(this._undo);
  }

  // ── AUTO / RESET (epic #1370, restored by #2244) ──────────────────────
  // Both are global image actions, so they live in the top bar next to
  // undo/info/export rather than in the tool dock (a `role="navigation"`
  // tool switcher). They were unreachable between the canvas-first redesign
  // and #2244: their only host was `DevelopToolbarComponent`, which the
  // retired S5 detail panel mounted.

  /** True once an asset is loaded — both controls need one to act on. */
  readonly hasFocusedAsset = computed<boolean>(() => this.state.focusedAssetId() != null);

  /** AUTO is unavailable without an asset and while an analysis is running. */
  readonly autoDisabled = computed<boolean>(
    () => !this.hasFocusedAsset() || this.editorState.autoInFlight(),
  );

  /** Analyse the RAW and apply AUTO's exposure (+ `autoExposure: 'Off'`, the
   *  epic's load-bearing AE contract) as one undo entry. */
  onAuto(): void {
    const id = this.state.focusedAssetId();
    if (id == null) return;
    void this.editorState.applyAuto(id);
  }

  /** Sliders → factory defaults, WB → As Shot, profile → Auto; crop kept. */
  onResetAll(): void {
    if (!this.hasFocusedAsset()) return;
    this.editorState.resetAll();
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
