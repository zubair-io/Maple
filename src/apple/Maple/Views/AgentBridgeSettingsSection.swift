#if os(macOS)
  import MapleCore
  import MapleUI
  import SwiftUI

  /// Settings → General → AI Agents. Opt-in switch for the local socket an
  /// MCP client (e.g. Claude Desktop via `maple-mcp`) uses to edit the open
  /// photo live.
  struct AgentBridgeSettingsSection: View {
    @State private var controller = AgentBridgeController.shared
    @AppStorage(AgentBridgeController.enabledDefaultsKey) private var enabled = false

    var body: some View {
      Section("AI Agents") {
        Toggle(isOn: $enabled) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Allow AI agents to edit the open photo")
            Text(
              "A local agent on this Mac can read and adjust the photo in the editor. Every change is one undo step and the sliders move as it works."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
          }
        }
        .accessibilityIdentifier("general.settings.agentBridge")
        if enabled {
          status
        }
      }
      .listRowBackground(MapleTokens.surface)
      .onChange(of: enabled) { _, newValue in
        controller.setEnabled(newValue)
      }
    }

    @ViewBuilder
    private var status: some View {
      if let error = controller.lastError {
        Label(error, systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(.orange)
      } else if controller.isListening {
        Label("Listening for local agents", systemImage: "checkmark.circle")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }
#endif
