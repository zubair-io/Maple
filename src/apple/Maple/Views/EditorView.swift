// EditorView.swift — shared iPad/Mac inspector and compact iPhone controls.
// State belongs to EditorSessionHost or EditorDestination and is never
// recreated by a resize or rotation.

import MapleCore
import SwiftUI

/// iPad/Mac measure the offered width, including Split View or an Info
/// inspector. iPhone keeps its compact control family in both orientations.
struct EditorView: View {
  @Bindable var state: EditorState
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  let onDismiss: () -> Void
  let onInfo: () -> Void
  var filmstripAssets: [AssetRef] = []
  var onSelectAsset: (AssetRef) -> Void = { _ in }
  var filmstripSource: (any ImageSource)? = nil
  #if os(iOS)
    @State private var screenSaverID = UUID()
  #endif

  var body: some View {
    GeometryReader { geometry in
      let layout = EditorLayout(
        width: geometry.size.width, idiom: MapleShellKind.currentIdiom,
        regularHorizontalSizeClass: horizontalSizeClass == .regular)
      // The closed Duo reserves a wide trailing safe-area rail beneath the
      // clock. Its horizontal size class is compact, so size class alone
      // cannot distinguish it from an ordinary iPhone portrait screen.
      // A conventional iPhone's landscape sensor inset is smaller than the
      // Duo's dedicated control rail; don't move its group tabs by mistake.
      let hasSideRail =
        geometry.safeAreaInsets.trailing
        > geometry.safeAreaInsets.leading + 72
      let usesDuoToolRail = MapleShellKind.currentIdiom == .phone && hasSideRail
      EditorSurface(
        state: state, onDismiss: onDismiss, onInfo: onInfo,
        filmstripAssets: filmstripAssets, onSelectAsset: onSelectAsset,
        filmstripSource: filmstripSource, usesPhoneControls: layout.usesPhoneControls,
        usesDuoToolRail: usesDuoToolRail
      )
      .environment(\.mapleLayout, layout.density)
    }
    #if os(iOS)
      .onAppear { BackupScreenSaverController.shared.editorAppeared(screenSaverID) }
      .onDisappear { BackupScreenSaverController.shared.editorDisappeared(screenSaverID) }
    #endif
  }
}

struct EditorSurface: View {
  @Bindable var state: EditorState
  let onDismiss: () -> Void
  let onInfo: () -> Void

  /// Optional filmstrip data — when empty the filmstrip rail collapses.
  var filmstripAssets: [AssetRef] = []
  var onSelectAsset: (AssetRef) -> Void = { _ in }
  /// Source the filmstrip assets came from, forwarded to ThumbnailLoader.
  var filmstripSource: (any ImageSource)? = nil

  let usesPhoneControls: Bool
  let usesDuoToolRail: Bool

  @Environment(\.mapleLayout) private var layout

  /// Presets sheet / popover.
  @State private var presetsOpen = false
  @State private var presetStore = PresetStore()

  /// Export panel (#3403). Owned here, not by the hosts, so the pill's
  /// Share button reaches the same `ExportPanel` on iPhone, iPad and Mac —
  /// the iPhone host used to hand `EditorView` a no-op share closure.
  @State private var showExport = false
  @State private var workflowOpen = false

  /// Frame (in `editorCanvas` space) of whichever floating chrome panel is
  /// currently reporting itself as a wheel-exclusion region. The shared
  /// adjustments panel and dock own scrolling over their own surfaces.
  /// Threaded into `CanvasZoomHost` so a trackpad scroll over the panel
  /// reaches the panel's own `ScrollView` instead of nudging the armed
  /// tool or zooming/panning the canvas underneath it.
  @State private var wheelExclusionFrame: CGRect?

  /// Global frames of the header, controls and filmstrip floating over the
  /// canvas: the canvas fits and centres the photo in what they leave visible.
  /// `nil` until they first report, a layout pass after the canvas (#5769);
  /// the canvas draws nothing until then, so the header must always report.
  @State private var canvasCoverFrames: [CGRect]?
  @State private var removalReturnTool: Tool = .exposure

  /// Whether the vectorscope HUD is showing (#3277). Persisted so the
  /// choice survives app restarts; the HUD itself arms
  /// `session.scopeEnabled` on appear.
  @AppStorage("editor.showsScope") private var showsScope = false

  /// Whether the four-up scopes panel is showing (#3251) — regular width
  /// only, mounted beside the filmstrip rail. Persisted like `showsScope`.
  @AppStorage("editor.showsScopesPanel") private var showsScopesPanel = false

  /// The GPU-live present and the CPU fallback both gate their scope work
  /// on `session.scopeEnabled`: on while either scope surface is showing.
  private var scopeProducerArmed: Bool { showsScope || (isRegular && showsScopesPanel) }

  var isRegular: Bool { layout != .phone }

  private var isFocusedMacRemoval: Bool {
    #if os(macOS)
      state.armedTool == .remove
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
        wheelExclusionFrame: wheelExclusionFrame,
        coverFrames: isFocusedMacRemoval ? [] : canvasCoverFrames,
        hasFilmstrip: !isFocusedMacRemoval && !filmstripAssets.isEmpty
      )

      // ── LAYER 1 : value HUD (center, fades in during scrub) ───────
      // The overlay owns its value observation and idle timer, so input
      // does not invalidate the surrounding editor shell.
      if !isFocusedMacRemoval { EditorValueHUD(state: state) }

      // ── LAYER 2 : left filmstrip rail (regular only) ───────────────
      // Vertically centered with its own max-height cap (set inside
      // FilmstripRail) so it floats mid-canvas instead of spanning the
      // full height.  `alignment: .leading` = left edge + vertical center.
      if isRegular && !isFocusedMacRemoval && !filmstripAssets.isEmpty {
        FilmstripRail(
          assets: filmstripAssets,
          activeID: state.session.asset.id,
          source: filmstripSource,
          onSelect: onSelectAsset
        )
        .coversCanvas()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(.leading, EditorCropGeometry.filmstripLeadingPadding)
        .ignoresSafeArea(edges: .bottom)
      }

      // ── LAYER 2b : scopes panel (regular only, #3251) ──────────────
      // Top-leading, beside the filmstrip rail and under the pill: the
      // trailing edge is owned by the shared inspector and dock, and the
      // rail is vertically centred, so this corner is the one spot the
      // four-up panel sits without covering a control.
      if isRegular && !isFocusedMacRemoval && showsScopesPanel {
        EditorScopesPanel(state: state)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .padding(
            .leading,
            EditorCropGeometry.filmstripLeadingPadding + FilmstripRail.railWidth
              + EditorCropGeometry.filmstripLeadingPadding
          )
          .padding(.top, 60)
      }

      // The open landscape Duo uses the vertical control bar. Its closed
      // display keeps the compact slider controls but moves group selection
      // into the trailing side rail. EditorState survives either reflow.
      if isFocusedMacRemoval {
        FocusedRemovalControls(state: state)
      } else {
        Group {
          if usesPhoneControls {
            GeometryReader { geometry in
              VStack {
                Spacer(minLength: 0)
                IPhoneControlBar(
                  state: state, onPresetsTap: { presetsOpen = true },
                  maximumPanelHeight: min(300, geometry.size.height * 0.4),
                  showsGroupTabs: !usesDuoToolRail, showsScope: showsScope
                )
                .reportsWheelExclusion(in: "editorCanvas", active: true)
                .coversCanvas()
              }
              .frame(maxWidth: .infinity, maxHeight: .infinity)
              .ignoresSafeArea(edges: .bottom)
            }
          } else {
            EditorControls(
              state: state, onPresetsTap: { presetsOpen = true },
              hasFilmstrip: !filmstripAssets.isEmpty, showsScope: showsScope
            )
          }
        }
        .disabled(!state.session.hasLoadedSidecar || state.session.isSavingRemoval)
        .popover(isPresented: presetsPresented(asSheet: false), arrowEdge: .trailing) {
          presetsPanel.frame(width: 340, height: 460)
        }
        #if os(iOS)
          .mapleBottomSheet(isPresented: presetsPresented(asSheet: true)) { presetsPanel }
        #endif
      }

      // Navigation and actions remain visible while adjusting the photo.
      if !isFocusedMacRemoval {
        VStack(spacing: 0) {
          HStack {
            Spacer(minLength: 0)
            PillHeader(
              state: state,
              onBack: onDismiss,
              onShare: { showExport = true },
              onInfo: onInfo,
              onWorkflow: {
                state.endGesture()
                state.whiteBalancePicker.cancel()
                state.session.workflow.isPresented = true
                workflowOpen = true
              },
              showsScope: $showsScope,
              showsScopesPanel: $showsScopesPanel,
              scopesPanelAvailable: isRegular,
              showsGroupSwitcher: headerCarriesGroups
            )
            .coversCanvas()
            Spacer(minLength: 0)
          }
          EditorSidecarLoadNotice(session: state.session)
            .padding(.top, 8)
          Spacer()
        }
        .statusRowHeaderPlacement(surface: "editor")
        .ignoresSafeArea(edges: .bottom)
        #if os(iOS)
          if sideRailCarriesGroups {
            EditorSideGroupRail(state: state)
          }
        #endif
        // Keep per-frame rendering observations inside the status leaf.
        EditorRenderStatus(state: state)
      } else {
        RemovalExitButton(state: state, returnTool: removalReturnTool)
      }

    }
    .disabled(state.session.workflow.isBusy)
    .sheet(isPresented: $workflowOpen) {
      EditorWorkflowPanel(session: state.session).disabled(false)
    }
    .onChange(of: workflowOpen) { _, open in state.session.workflow.isPresented = open }
    .sheet(isPresented: $showExport) {
      ExportPanel(session: state.session)
    }
    .overlay(alignment: .topTrailing) {
      if !isFocusedMacRemoval {
        VStack(alignment: .trailing, spacing: 8) {
          // GPU frame-time HUD — validation-only (gpu build +
          // MAPLE_GPU_HUD=1); compiles out / EmptyView otherwise. Ported
          // from the legacy FullImageView when it was retired (#1807).
          EditorFrameTimeHUD(session: state.session)
        }
        .padding(.top, 60)
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
    .onPreferenceChange(CanvasCoverFramesKey.self) { canvasCoverFrames = $0 }
    // Scope producer arming (#3277, #3251): one switch for both scope
    // surfaces, so hiding the HUD while the panel is up (or vice versa)
    // cannot disarm the producer the other one still reads.
    .onChange(of: scopeProducerArmed, initial: true) { _, armed in
      state.session.scopeEnabled = armed
    }
    .onChange(of: state.armedTool) { oldTool, newTool in
      if newTool == .remove, oldTool != .remove {
        removalReturnTool = oldTool
      }
    }
    .onDisappear {
      state.removal.close()
      state.session.scopeEnabled = false
      state.session.workflow.invalidate()
    }
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
      // Browse hydration may have been cancelled as its cell disappeared.
      // Restore the complete sidecar before the editor requests real pixels.
      await state.session.loadSidecar()
      guard !Task.isCancelled else { return }
      state.session.ensureRenderStarted()
      if state.armedTool == .remove, !state.removal.active {
        await state.removal.open()
      }
    }
    .onChange(of: state.armedTool) { _, tool in
      guard tool == .remove, state.session.hasLoadedSidecar, !state.removal.active else { return }
      Task { await state.removal.open() }
    }
    #if os(macOS)
      // Hide the macOS window toolbar in editor mode so the canvas is
      // full-bleed; zoom controls have moved into the pill header.
      // The toolbar reappears automatically when the editor is dismissed
      // (EditorView leaves the view hierarchy and its modifier disappears).
      .toolbar(.hidden, for: .windowToolbar)
    #elseif os(iOS)
      .toolbar(.hidden, for: .navigationBar)
    #endif
    // Editor key commands (arrows, compare, nudge, filmstrip navigation)
    // are routed by one shared scope so a focused slider or text field can
    // claim a key first and the shell only handles what is left.
    .modifier(EditorCommandScope(state: state, navigate: navigateFilmstrip))
    .id(ObjectIdentifier(state.session))
  }

  /// The closed Duo's compact controls hand group selection to the trailing
  /// side rail (#5770). The open Duo carries it in the header row instead
  /// (#5710). Neither uses the navigation bar, which would push the header
  /// down a level.
  private var sideRailCarriesGroups: Bool { usesDuoToolRail && usesPhoneControls }
  private var headerCarriesGroups: Bool { usesDuoToolRail && !usesPhoneControls }

  private func navigateFilmstrip(_ direction: Int) {
    guard let index = filmstripAssets.firstIndex(where: { $0.id == state.session.asset.id }),
      filmstripAssets.indices.contains(index + direction)
    else { return }
    state.cancelGesture()
    state.session.endEdit()
    onSelectAsset(filmstripAssets[index + direction])
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
      onInfo: {}
    )
  }
#endif
