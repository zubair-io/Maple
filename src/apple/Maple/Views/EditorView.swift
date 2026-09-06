// EditorView.swift — one canvas-first editor on every Apple width (#3252).
// The same adjustments panel and tool dock move from the trailing edge to
// the bottom through MapleLayout. State belongs to EditorSessionHost or
// EditorDestination and is never recreated by a layout transition.

import MapleCore
import SwiftUI

/// The editor measures its own offered width, including Split View or an
/// open Info inspector. The outer phone shell's idiom stays unrelated to
/// this width-based layout, so rotating a wide phone uses the same rules.
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
      EditorSurface(
        state: state, onDismiss: onDismiss, onShare: onShare, onInfo: onInfo,
        filmstripAssets: filmstripAssets, onSelectAsset: onSelectAsset,
        filmstripSource: filmstripSource
      )
      .environment(\.mapleLayout, MapleLayout.from(width: geometry.size.width))
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
        wheelExclusionFrame: wheelExclusionFrame
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
        .padding(.leading, 12)
        .ignoresSafeArea(edges: .bottom)
      }

      // The same panel and dock reflow without replacing their view identity.
      EditorControls(state: state, onPresetsTap: { presetsOpen = true })
        #if os(macOS)
          .popover(isPresented: $presetsOpen, arrowEdge: .trailing) {
            presetsPanel.frame(width: 340, height: 460)
          }
        #else
          .mapleBottomSheet(isPresented: $presetsOpen) { presetsPanel }
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
    }
    #if os(macOS)
      // Hide the macOS window toolbar in editor mode so the canvas is
      // full-bleed; zoom controls have moved into the pill header.
      // The toolbar reappears automatically when the editor is dismissed
      // (EditorView leaves the view hierarchy and its modifier disappears).
      .toolbar(.hidden, for: .windowToolbar)
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
