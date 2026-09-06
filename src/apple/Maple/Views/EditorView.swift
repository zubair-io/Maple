// EditorView.swift — Pro Editor Canvas-first (A2, #1555).
//
// Canvas-first shell: a full-bleed image canvas fills the viewport and
// frosted-glass chrome layers float above it.  On regular size class
// (iPad/Mac) all five chrome elements are shown; on compact (iPhone)
// the left filmstrip rail and right tool dock are hidden, leaving only
// the top pill, the bottom control card, and the value-chip HUD.
//
// ┌─────────────────────────────────────────────────────────────────┐
// │      [back]  filename  [before/after]  [undo]  [info] [share]  │  ← top pill (glass)
// │                                                                 │
// │  [filmstrip  │                                  │  tool dock]  │
// │  [rail       │          CANVAS                  │  (right)  ]  │  ← regular only
// │  (left)      │     (full bleed, GPU/CPU)        │             │
// │              │                                  │             │
// │         [GROUP TABS ── living-slider grid]                     │  ← bottom card (glass)
// └─────────────────────────────────────────────────────────────────┘
//
// Control-panel variants (TEMPORARY — for design exploration):
//   .compact (.default) — ToolDock (group-switcher) on the right + ControlCard at the bottom.
//   .panel              — StackedAdjustmentsPanel replaces the dock + card.
// The variant is selected via `ControlVariantToggle` (a small segmented
// control placed top-trailing below the pill) and persisted with @AppStorage.
// Both the toggle and the branching in this file are clearly marked TEMPORARY
// and must be removed before the design review concludes.
//
// All existing canvas logic (CanvasZoomHost, GPU/CPU leaf, crop overlay,
// ValueChipOverlay, wheel nudge, zoom toolbar) is preserved unchanged.
// The header is `PillHeader` (frosted content-width pill); `DragBar` and
// `ToolPillRow` are kept as files (their previews and tests remain valid)
// but are no longer used in this layout.
//
// The chrome view structs each live in their own sibling file (the
// codebase convention — one view per file): PillHeader.swift,
// FilmstripRail.swift, ToolDock.swift, ControlCard.swift,
// LivingSliderGrid.swift, CanvasImageView.swift.  This file is the thin
// ZStack composer + the canvas-leaf wiring.
//
// Chrome recede: on compact, a 3-second idle timer dims the chrome to 0.15
// opacity; any touch on the canvas restores it.  Regular size class always
// keeps chrome fully visible.

import MapleCore
import SwiftUI

#if os(iOS)
  import UIKit
#endif

// MARK: - EditorView

struct EditorView: View {
  @Bindable var state: EditorState
  let onDismiss: () -> Void
  let onShare: () -> Void
  let onInfo: () -> Void

  /// Optional filmstrip data — when empty the filmstrip rail collapses.
  var filmstripAssets: [AssetRef] = []
  var onSelectAsset: (AssetRef) -> Void = { _ in }
  /// Source the filmstrip assets came from, forwarded to ThumbnailLoader.
  var filmstripSource: (any ImageSource)? = nil

  @Environment(\.horizontalSizeClass) private var hSizeClass

  /// Chrome recede state for compact (iPhone). Timer resets on any
  /// canvas interaction; regular size class never recedes.
  @State private var chromeVisible = true
  @State private var recedeTask: Task<Void, Never>?

  /// Presets sheet / popover.
  @State private var presetsOpen = false
  @State private var presetStore = PresetStore()

  /// Frame (in `editorCanvas` space) of whichever floating chrome panel is
  /// currently reporting itself as a wheel-exclusion region — e.g.
  /// `FlyoutSliderPanel` while its Film catalog list is showing (#2683).
  /// Threaded into `CanvasZoomHost` so a trackpad scroll over the panel
  /// reaches the panel's own `ScrollView` instead of nudging the armed
  /// tool or zooming/panning the canvas underneath it.
  @State private var wheelExclusionFrame: CGRect?

  // ── TEMPORARY: control-panel variant (exploration only) ──────────────────
  // Persisted with @AppStorage so the choice survives app restarts during
  // design review.  Default is `.compact` (the existing A2 layout).
  // REMOVE this property + the branching it drives before shipping.
  @AppStorage("proControlVariant") private var controlVariant: String = ControlVariant.compact
    .rawValue

  private var activeVariant: ControlVariant {
    ControlVariant(rawValue: controlVariant) ?? .compact
  }
  // ── END TEMPORARY ─────────────────────────────────────────────────────────

  private var isRegular: Bool { hSizeClass == .regular }

  /// The restored S5 control stack is deliberately phone-idiom-only.
  /// Size class alone is insufficient because an iPad can become compact
  /// in Split View and must retain its existing editor design.
  private var isIPhone: Bool {
    #if os(iOS)
      UIDevice.current.userInterfaceIdiom == .phone
    #else
      false
    #endif
  }

  var body: some View {
    ZStack {
      // ── LAYER 0 : full-bleed canvas ──────────────────────────────
      EditorCanvasView(
        state: state,
        filmstripSource: filmstripSource,
        wheelExclusionFrame: wheelExclusionFrame
      )
      .onTapGesture { bumpChrome() }

      // ── LAYER 1 : value HUD (center, fades in during scrub) ───────
      // The overlay owns its value observation and idle timer, so input
      // does not invalidate the surrounding editor shell.
      EditorValueHUD(state: state)

      // ── LAYER 2 : left filmstrip rail (regular only) ───────────────
      // Vertically centered with its own max-height cap (set inside
      // FilmstripRail) so it floats mid-canvas instead of spanning the
      // full height.  `alignment: .leading` = left edge + vertical center.
      if isRegular && !filmstripAssets.isEmpty {
        FilmstripRail(
          assets: filmstripAssets,
          activeID: state.session.asset.id,
          source: filmstripSource,
          onSelect: onSelectAsset
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(.leading, 12)
        .ignoresSafeArea(edges: .bottom)
        .opacity(chromeOpacity)
        .allowsHitTesting(isRegular || chromeVisible)
      }

      // ── LAYER 3 : right tool dock / panel (branched by variant) ────
      //
      // .compact — ToolDock (group-switcher) on the trailing edge.
      //            Regular only; hidden on compact (phone).
      // .panel   — StackedAdjustmentsPanel on the trailing edge (regular)
      //            or as a bottom panel (compact).  Dock hidden.
      //
      // TEMPORARY: the variant branch below is exploration scaffolding —
      // remove when the design review concludes.
      switch activeVariant {
      case .compact:
        // Variant A: group-switcher dock (regular only, matches original A2).
        if isRegular {
          ToolDock(state: state, onPresetsTap: { presetsOpen = true })
            #if os(macOS)
              .popover(isPresented: $presetsOpen, arrowEdge: .trailing) {
                PresetsPanel(
                  state: state,
                  store: presetStore,
                  onApplied: { presetsOpen = false }
                )
                .frame(width: 340, height: 460)
                .background(MapleTokens.surface)
              }
            #endif
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
            .padding(.trailing, 12)
            .ignoresSafeArea(edges: .bottom)
            .opacity(chromeOpacity)
            .allowsHitTesting(isRegular || chromeVisible)
        }

      case .panel:
        // Variant B: stacked panel — on regular it anchors to the
        // trailing edge (the panel itself is right-anchored inside
        // StackedAdjustmentsPanel on regular); on compact it sits at
        // the bottom.
        if !isIPhone {
          StackedAdjustmentsPanel(
            state: state,
            onPresetsTap: { presetsOpen = true }
          )
          #if os(macOS)
            .popover(isPresented: $presetsOpen, arrowEdge: .trailing) {
              PresetsPanel(
                state: state,
                store: presetStore,
                onApplied: { presetsOpen = false }
              )
              .frame(width: 340, height: 460)
              .background(MapleTokens.surface)
            }
          #endif
          .frame(
            maxWidth: .infinity, maxHeight: .infinity, alignment: isRegular ? .trailing : .bottom
          )
          .ignoresSafeArea(edges: .bottom)
          .opacity(chromeOpacity)
          .allowsHitTesting(isRegular || chromeVisible)
        }
      }

      // ── LAYER 3b : flyout slider panel (variant A / regular only) ──
      // The right-side single-group slider panel that sits just left of
      // the ToolDock — together they form the "Flyout — dock + slider
      // panel" Card layout.  Regular only; on compact (iPhone) the bottom
      // ControlCard (layer 5) is used instead.
      // TEMPORARY: control-variant exploration — remove with the rest.
      if activeVariant == .compact && isRegular {
        FlyoutSliderPanel(state: state)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
          .padding(.trailing, 88)  // 12 dock pad + 64 dock width + 12 gap
          .ignoresSafeArea(edges: .bottom)
          .opacity(chromeOpacity)
          .allowsHitTesting(isRegular || chromeVisible)
          // Excludes this panel's frame from CanvasZoomHost's
          // scroll-wheel catcher ONLY while Film is armed — that's
          // the one tool whose surface (`FilmSection`'s category
          // chip row + catalog list) owns its own scrollable
          // content the wheel catcher would otherwise hijack into
          // wheel-nudge/zoom (#2683). Every other tool keeps
          // relying on wheel-over-panel reaching `onWheelEditing`
          // (the documented plain-wheel armed-tool nudge,
          // `CanvasZoomHost`'s own header comment) — an
          // unconditional exclusion here would silently break
          // that for every non-Film tool (#2683 round-2 review).
          .reportsWheelExclusion(in: "editorCanvas", active: state.armedTool == .filmLook)
      }

      // ── LAYER 4 : top pill header ─────────────────────────────────
      //
      // Pill is centered horizontally so it floats symmetrically above
      // the canvas.  The ControlVariantToggle (exploration control) has
      // moved to Settings → General so it no longer clutters the canvas
      // chrome.
      VStack(spacing: 0) {
        HStack {
          Spacer(minLength: 0)
          PillHeader(
            state: state,
            onBack: onDismiss,
            onShare: onShare,
            onInfo: onInfo
          )
          Spacer(minLength: 0)
        }
        Spacer()
      }
      .padding(.top, 8)
      .frame(maxWidth: .infinity)
      .ignoresSafeArea(edges: .bottom)
      // The classic iPhone controls are persistent, so their header
      // must remain equally stable instead of dimming after idle.
      .opacity(isIPhone ? 1 : chromeOpacity)
      .allowsHitTesting(isIPhone || isRegular || chromeVisible)

      // ── LAYER 5 : bottom control bar (variant A / compact only) ───────
      //
      // Hidden when the panel variant is active — StackedAdjustmentsPanel
      // (layer 3) provides all slider controls.
      // Regular replaces this with FlyoutSliderPanel (layer 3b);
      // MobileControlBar is shown only on compact (iPhone).
      // MobileControlBar replaces ControlCard here; ControlCard.swift
      // is retained as a file (its preview / tests remain valid) but is
      // no longer mounted in this layout.
      if isIPhone {
        VStack {
          Spacer()
          IPhoneLegacyControlBar(
            state: state,
            onPresetsTap: { presetsOpen = true }
          )
          #if os(iOS)
            .mapleBottomSheet(isPresented: $presetsOpen) {
              PresetsPanel(
                state: state,
                store: presetStore,
                onApplied: { presetsOpen = false }
              )
            }
          #endif
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(edges: .bottom)
      } else if activeVariant == .compact && !isRegular {
        VStack {
          Spacer()
          MobileControlBar(
            state: state,
            onPresetsTap: { presetsOpen = true }
          )
          #if os(iOS)
            .mapleBottomSheet(isPresented: $presetsOpen) {
              PresetsPanel(
                state: state,
                store: presetStore,
                onApplied: { presetsOpen = false }
              )
            }
          #endif
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(edges: .bottom)
        .opacity(chromeOpacity)
        .allowsHitTesting(isRegular || chromeVisible)
      }

      // Status observations belong to a leaf: per-frame publication
      // must not rebuild the filmstrip, tool dock, and controls.
      EditorRenderStatus(session: state.session)

    }
    .overlay(alignment: .topTrailing) {
      // GPU frame-time HUD — validation-only (gpu build +
      // MAPLE_GPU_HUD=1); compiles out / EmptyView otherwise. Ported
      // from the legacy FullImageView when it was retired (#1807).
      EditorFrameTimeHUD(session: state.session)
    }
    // Full-bleed editor (#4 follow-up): on regular size class (Mac/iPad)
    // pull the content into the top safe-area inset left over from the
    // (now-hidden) title bar/toolbar so the canvas + pill reach the very
    // top edge instead of leaving an empty black strip. Compact (iPhone)
    // keeps its top inset so the pill clears the notch/status bar.
    .ignoresSafeArea(edges: isRegular ? .top : [])
    .background(MapleTokens.bg.ignoresSafeArea())
    // Shared coordinate space for wheel-exclusion frame reporting
    // (#2683) — see `wheelExclusionFrame`.
    .coordinateSpace(name: "editorCanvas")
    .onPreferenceChange(CanvasWheelExclusionKey.self) { wheelExclusionFrame = $0 }
    // Scope the shell identifier to a CONTAINER element (#1769). A bare
    // `.accessibilityIdentifier` on a multi-element view BROADCASTS the
    // identifier onto every contained accessibility element, overriding
    // the ones they set for themselves — a11y dumps showed every editor
    // element (the `canvas-render-ready` sentinel, `canvas-zoom-indicator`,
    // even toolbar buttons) reading `editor-view` on BOTH platforms, which
    // silently broke the macOS golden visual harness (it waits on the
    // canvas sentinel) and blocked the iPad seam harness. `.contain`
    // makes `editor-view` its own container node and leaves descendants'
    // identifiers intact.
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-view")
    // Kick the render once this view is the active editor for the
    // current asset.  `ensureRenderStarted()` is idempotent (guards
    // on `renderedPreview == nil`) and re-runs when the asset id
    // changes (filmstrip sibling switch).
    .task(id: state.session.asset.id) {
      state.session.ensureRenderStarted()
      scheduleRecede()
    }
    #if os(macOS)
      // Hide the macOS window toolbar in editor mode so the canvas is
      // full-bleed; zoom controls have moved into the pill header.
      // The toolbar reappears automatically when the editor is dismissed
      // (EditorView leaves the view hierarchy and its modifier disappears).
      .toolbar(.hidden, for: .windowToolbar)
    #endif
    .onChange(of: state.armedTool) { _, _ in bumpChrome() }
    .onChange(of: state.armedGroup) { _, _ in bumpChrome() }
    // The HUD owns its timer; this shell owns only chrome recede.
    .onDisappear {
      recedeTask?.cancel()
    }
    // ── Arrow-key group cycling (regular / iPad & Mac only) ────────────
    // Down = next group (Detail → Light wraps), Up = previous.
    // `.focusable(isRegular)` makes the ZStack a key-event target when
    // no child slider has focus.  A focused LivingSlider consuming
    // `.handled` on its own arrow keys takes priority (innermost first).
    // CAVEAT TO VERIFY: on macOS focus may not land here after clicking
    // away from a slider — if so, add `.focusScope` or make the canvas
    // `.focusable()` as the default target.  On iPadOS this modifier is
    // load-bearing for hardware-keyboard delivery; confirm on device.
    .focusable(isRegular)
    .onKeyPress(.downArrow) {
      guard isRegular else { return .ignored }
      let all = ToolGroup.allCases
      let current = state.armedGroup
      let next = all[(all.firstIndex(of: current)! + 1) % all.count]
      withAnimation(MapleTokens.Motion.groupSwap) { state.arm(group: next) }
      return .handled
    }
    .onKeyPress(.upArrow) {
      guard isRegular else { return .ignored }
      let all = ToolGroup.allCases
      let current = state.armedGroup
      let prev = all[(all.firstIndex(of: current)! + all.count - 1) % all.count]
      withAnimation(MapleTokens.Motion.groupSwap) { state.arm(group: prev) }
      return .handled
    }
  }

  // MARK: - Chrome recede

  private var chromeOpacity: Double {
    guard !isRegular && !chromeVisible else { return 1.0 }
    return 0.15
  }

  private func bumpChrome() {
    guard !isRegular else { return }
    recedeTask?.cancel()
    chromeVisible = true
    scheduleRecede()
  }

  private func scheduleRecede() {
    guard !isRegular else { return }
    recedeTask?.cancel()
    recedeTask = Task {
      try? await Task.sleep(for: .seconds(3))
      guard !Task.isCancelled else { return }
      withAnimation(.easeOut(duration: ProMotion.recede)) {
        chromeVisible = false
      }
    }
  }

}

// MARK: - Preview

#if DEBUG
  #Preview("EditorView") {
    let state = EditorState(session: EditSession.preview())
    return EditorView(
      state: state,
      onDismiss: {},
      onShare: {},
      onInfo: {}
    )
  }
#endif
