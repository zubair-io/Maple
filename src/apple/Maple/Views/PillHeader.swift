import MapleCore
import SwiftUI

/// Native floating photo controls. Secondary commands remain available in More.
struct PillHeader: View {
  @Bindable var state: EditorState
  @Environment(\.editorCommandRouter) private var router
  let onBack: () -> Void
  let onShare: () -> Void
  let onInfo: () -> Void
  let onWorkflow: () -> Void
  @Binding var showsScope: Bool
  @Binding var showsScopesPanel: Bool
  let scopesPanelAvailable: Bool
  /// The open Duo carries the group switcher in this row (#5710).
  var showsGroupSwitcher = false

  var body: some View {
    header
      .buttonStyle(.plain)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("editor-pill-header")
  }

  @ViewBuilder private var header: some View {
    #if os(iOS)
      if showsGroupSwitcher {
        FloatingImageHeader(identifierPrefix: "editor", onBack: onBack) {
          EditorHistogramChip(session: state.session)
        } trailing: {
          actions
        } accessory: {
          EditorGroupSwitcher(state: state)
            .accessibilityIdentifier("editor-header-groups")
        }
      } else {
        plainHeader
      }
    #else
      plainHeader
    #endif
  }

  private var plainHeader: some View {
    FloatingImageHeader(identifierPrefix: "editor", onBack: onBack) {
      EditorHistogramChip(session: state.session)
    } trailing: {
      actions
    }
  }

  @ViewBuilder private var actions: some View {
    EditorAutoButton(state: state)
      .id(ObjectIdentifier(state.session))

    Button {
      perform(.undo)
    } label: {
      Image(systemName: "arrow.uturn.backward")
        .font(.system(size: 22))
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .disabled(!state.canUndo)
    .accessibilityLabel("Undo")
    .accessibilityIdentifier("editor-undo")
    .help("Undo (⌘Z)")

    overflowMenu
  }

  private var overflowMenu: some View {
    Menu {
      Section {
        Button {
          perform(.compareToggle)
        } label: {
          Label(
            state.session.showingOriginal ? "Show Edited" : "Compare with Original",
            systemImage: "circle.lefthalf.filled"
          )
        }
        .disabled(!state.isDirty && !state.session.showingOriginal)
        .accessibilityIdentifier("editor-before-after")
        .accessibilityValue(state.session.showingOriginal ? "Original" : "Edited")

        Button {
          perform(.redo)
        } label: {
          Label("Redo", systemImage: "arrow.uturn.forward")
        }
        .disabled(!state.canRedo)
        .accessibilityIdentifier("editor-redo")
      }

      Section {
        Button("Snapshots and history", action: onWorkflow)
          .disabled(
            state.session.workflow.isBusy || state.autoInProgress
              || state.whiteBalancePicker.isSampling
          )
          .accessibilityLabel("Snapshots and history")
          .accessibilityIdentifier("editor-workflow")

        Button(action: onInfo) {
          Label("Photo Info", systemImage: "info.circle")
        }
        .accessibilityIdentifier("editor-info")

        Button(action: onShare) {
          Label("Share / Export…", systemImage: "square.and.arrow.up")
        }
        .accessibilityIdentifier("editor-share")

        Toggle(isOn: $showsScope) {
          Label("Show Vectorscope", systemImage: "circle.hexagongrid")
        }
        .accessibilityIdentifier("editor-pill-scope")

        if scopesPanelAvailable {
          Toggle(isOn: $showsScopesPanel) {
            Label("Show Scopes", systemImage: "waveform.path.ecg.rectangle")
          }
          .accessibilityIdentifier("editor-pill-scopes")
        }
      }

      Section {
        Button {
          perform(.fit)
        } label: {
          Label("Zoom to Fit", systemImage: "arrow.up.left.and.arrow.down.right")
        }
        .disabled(state.zoom.displayFrameInPoints == nil || state.zoom.isZoomLocked)
        .accessibilityValue(
          state.zoom.provisionalImageSize == nil
            ? FullImageViewVM.zoomAccessibilityLabel(for: state.zoom.effectivePixelScale)
            : CanvasZoomBadge.unknownZoomAccessibilityValue
        )
        .accessibilityIdentifier("editor-pill-zoom")

        Button {
          state.zoom.zoomToFill()
        } label: {
          Label("Zoom to Fill", systemImage: "aspectratio")
        }
        .disabled(state.zoom.displayFrameInPoints == nil || state.zoom.isZoomLocked)
        .accessibilityIdentifier("editor-pill-zoom-fill")
      }
    } label: {
      Image(systemName: "ellipsis")
        .font(.system(size: 22))
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    #if os(macOS)
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
    #endif
    .accessibilityLabel("More photo actions")
    .accessibilityIdentifier("editor-more")
  }

  private func perform(_ command: EditorCommandRouter.Command) {
    router?.perform(command, assetID: state.session.asset.id)
  }
}
