// EditorView.swift — shared iPad/Mac inspector and compact iPhone controls.
// State belongs to EditorSessionHost or EditorDestination and is never
// recreated by a resize or rotation.

import MapleCore
import SwiftUI

/// iPad/Mac measure the offered width, including Split View or an Info
/// inspector. iPhone keeps its compact control family in both orientations.
struct EditorView: View {
  @Bindable var state: EditorState
  let onDismiss: () -> Void
  let onShare: () -> Void
  let onInfo: () -> Void
  var filmstripAssets: [AssetRef] = []
  var onSelectAsset: (AssetRef) -> Void = { _ in }
  var filmstripSource: (any ImageSource)? = nil

  var body: some View {
    GeometryReader { geometry in
      let layout = EditorLayout(
        width: geometry.size.width, idiom: MapleShellKind.currentIdiom)
      EditorSurface(
        state: state, onDismiss: onDismiss, onShare: onShare, onInfo: onInfo,
        filmstripAssets: filmstripAssets, onSelectAsset: onSelectAsset,
        filmstripSource: filmstripSource, usesPhoneControls: layout.usesPhoneControls
      )
      .environment(\.mapleLayout, layout.density)
    }
  }
}

struct EditorSurface: View {
  @Bindable var state: EditorState
  let onDismiss: () -> Void
  let onShare: () -> Void
  let onInfo: () -> Void

  /// Optional filmstrip data — when empty the filmstrip rail collapses.
  var filmstripAssets: [AssetRef] = []
  var onSelectAsset: (AssetRef) -> Void = { _ in }
  /// Source the filmstrip assets came from, forwarded to ThumbnailLoader.
  var filmstripSource: (any ImageSource)? = nil

  let usesPhoneControls: Bool

  @Environment(\.mapleLayout) private var layout

  /// Presets sheet / popover.
  @State private var presetsOpen = false
  @State private var presetStore = PresetStore()

  /// Frame (in `editorCanvas` space) of whichever floating chrome panel is
  /// currently reporting itself as a wheel-exclusion region. The shared
  /// adjustments panel and dock own scrolling over their own surfaces.
  /// Threaded into `CanvasZoomHost` so a trackpad scroll over the panel
  /// reaches the panel's own `ScrollView` instead of nudging the armed
  /// tool or zooming/panning the canvas underneath it.
  @State private var wheelExclusionFrame: CGRect?

  /// Whether the vectorscope HUD is showing (#3277). Persisted so the
  /// choice survives app restarts; the HUD itself arms
  /// `session.scopeEnabled` on appear.
  @AppStorage("editor.showsScope") private var showsScope = false

  var isRegular: Bool { layout != .phone }

  var body: some View {
    ZStack {
      // ── LAYER 0 : full-bleed canvas ──────────────────────────────
      EditorCanvasView(
        state: state,
        filmstripSource: filmstripSource,
        wheelExclusionFrame: wheelExclusionFrame,
        hasFilmstrip: !filmstripAssets.isEmpty
      )

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
        .padding(.leading, EditorCropGeometry.filmstripLeadingPadding)
        .ignoresSafeArea(edges: .bottom)
      }

      // Device identity selects the control family once. Width only reflows
      // the shared iPad/Mac inspector; it never replaces the phone controls.
      Group {
        if usesPhoneControls {
          GeometryReader { geometry in
            VStack {
              Spacer(minLength: 0)
              IPhoneControlBar(
                state: state, onPresetsTap: { presetsOpen = true },
                maximumPanelHeight: min(300, geometry.size.height * 0.4)
              )
              .reportsWheelExclusion(in: "editorCanvas", active: true)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .ignoresSafeArea(edges: .bottom)
          }
        } else {
          EditorControls(state: state, onPresetsTap: { presetsOpen = true })
        }
      }
      .popover(isPresented: presetsPresented(asSheet: false), arrowEdge: .trailing) {
        presetsPanel.frame(width: 340, height: 460)
      }
      #if os(iOS)
        .mapleBottomSheet(isPresented: presetsPresented(asSheet: true)) { presetsPanel }
      #endif

      // Navigation and actions remain visible while adjusting the photo.
      VStack(spacing: 0) {
        HStack {
          Spacer(minLength: 0)
          PillHeader(
            state: state,
            onBack: onDismiss,
            onShare: onShare,
            onInfo: onInfo,
            showsScope: $showsScope
          )
          Spacer(minLength: 0)
        }
        Spacer()
      }
      .padding(.top, 8)
      .frame(maxWidth: .infinity)
      .ignoresSafeArea(edges: .bottom)
      // Keep per-frame rendering observations inside the status leaf.
      EditorRenderStatus(session: state.session)

    }
    .overlay(alignment: .topTrailing) {
      VStack(alignment: .trailing, spacing: 8) {
        // GPU frame-time HUD — validation-only (gpu build +
        // MAPLE_GPU_HUD=1); compiles out / EmptyView otherwise. Ported
        // from the legacy FullImageView when it was retired (#1807).
        EditorFrameTimeHUD(session: state.session)
        // Skin-tone vectorscope HUD (#3277) — toggled by the pill's
        // "Scope" button, persisted via `showsScope`.
        if showsScope {
          VectorscopeHud(state: state)
        }
      }
    }
    // Mac extends under its hidden window toolbar. iOS keeps the top
    // inset so the editor header stays clear of system status/navigation.
    #if os(macOS)
      .ignoresSafeArea(edges: isRegular ? .top : [])
    #endif
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
    }
    #if os(macOS)
      // Hide the macOS window toolbar in editor mode so the canvas is
      // full-bleed; zoom controls have moved into the pill header.
      // The toolbar reappears automatically when the editor is dismissed
      // (EditorView leaves the view hierarchy and its modifier disappears).
      .toolbar(.hidden, for: .windowToolbar)
    #elseif os(iOS)
      // The editor supplies its own header. A retained Browse navigation
      // bar can intercept these buttons on iPad, especially after rotation.
      .toolbar(.hidden, for: .navigationBar)
    #endif
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

  private var presetsUseSheet: Bool {
    #if os(iOS)
      layout == .phone
    #else
      false
    #endif
  }

  private func presetsPresented(asSheet: Bool) -> Binding<Bool> {
    Binding(
      get: { presetsOpen && presetsUseSheet == asSheet },
      set: { if presetsUseSheet == asSheet { presetsOpen = $0 } }
    )
  }

  private var presetsPanel: some View {
    PresetsPanel(state: state, store: presetStore, onApplied: { presetsOpen = false })
      .background(MapleTokens.surface)
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
