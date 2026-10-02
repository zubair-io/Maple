import MapleCore
import SwiftUI

/// Native floating photo controls. Secondary commands remain available in More.
struct PillHeader: View {
  @Bindable var state: EditorState
  @Environment(\.editorCommandRouter) private var router
  let onBack: () -> Void
  let onShare: () -> Void
  let onInfo: () -> Void
  @Binding var showsScope: Bool
  @Binding var showsScopesPanel: Bool
  let scopesPanelAvailable: Bool

  var body: some View {
    FloatingImageHeader(identifierPrefix: "editor", onBack: onBack) {
      MiniHistogram(session: state.session)
        .frame(maxWidth: 140)
        .frame(height: 26)
        .padding(.horizontal, 12)
        .allowsHitTesting(false)
        .accessibilityLabel("RGB histogram")
        .accessibilityIdentifier("editor-pill-histogram")
    } trailing: {
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
    .buttonStyle(.plain)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-pill-header")
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
        .disabled(state.zoom.displayFrameInPoints == nil)
        .accessibilityValue(
          FullImageViewVM.zoomAccessibilityLabel(for: state.zoom.effectivePixelScale)
        )
        .accessibilityIdentifier("editor-pill-zoom")
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
