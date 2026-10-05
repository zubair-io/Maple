#if os(macOS)
  import AppKit
  import MapleCore
  import MapleUI
  import SwiftUI

  /// Settings → General → AI Agents. Opt-in switch for the local socket an
  /// MCP client (e.g. Claude Desktop via `maple-mcp`) uses to edit the open
  /// photo live.
  struct AgentBridgeSettingsSection: View {
    @State private var controller = AgentBridgeController.shared
    @AppStorage(AgentBridgeController.enabledDefaultsKey) private var enabled = false
    @State private var copiedSocket = false
    @State private var copiedConfig = false
    @State private var socketCopyGeneration = 0
    @State private var configCopyGeneration = 0

    var body: some View {
      Section("AI Agents") {
        Toggle(isOn: $enabled) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Allow AI agents to edit the open photo")
            Text(
              "A local agent on this Mac can read and adjust the photo in the editor. Every change is one undo step and the sliders move as it works."
            )
            .font(.caption)
            .foregroundStyle(MapleTokens.textMuted)
          }
        }
        .accessibilityIdentifier("general.settings.agentBridge")

        if enabled {
          status

          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text("Socket Endpoint")
                .font(.caption)
                .foregroundStyle(MapleTokens.textMuted)
              Spacer()
              Button {
                copyToClipboard(controller.effectiveSocketPath)
                copiedSocket = true
                socketCopyGeneration += 1
              } label: {
                Label(
                  copiedSocket ? "Copied" : "Copy Path",
                  systemImage: copiedSocket ? "checkmark" : "doc.on.doc"
                )
                .font(.caption2)
              }
              .buttonStyle(.borderless)
              .accessibilityIdentifier("general.settings.agentBridge.copySocket")
            }

            Text(controller.effectiveSocketPath)
              .font(.system(.caption, design: .monospaced))
              .lineLimit(2)
              .truncationMode(.middle)
              .textSelection(.enabled)
              .padding(6)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(MapleTokens.bg)
              .clipShape(RoundedRectangle(cornerRadius: MapleTokens.Radius.sm))
              .accessibilityIdentifier("general.settings.agentBridge.socketPath")
          }
          .padding(.vertical, 2)

          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text("MCP Client Setup (e.g. Claude Desktop)")
                .font(.caption)
                .foregroundStyle(MapleTokens.textMuted)
              Spacer()
              Button {
                copyToClipboard(controller.mcpConfigurationSnippet)
                copiedConfig = true
                configCopyGeneration += 1
              } label: {
                Label(
                  copiedConfig ? "Copied" : "Copy Config",
                  systemImage: copiedConfig ? "checkmark" : "doc.on.doc"
                )
                .font(.caption2)
              }
              .buttonStyle(.borderless)
              .accessibilityIdentifier("general.settings.agentBridge.copyConfig")
            }

            Text(controller.mcpConfigurationSnippet)
              .font(.system(.caption, design: .monospaced))
              .textSelection(.enabled)
              .padding(8)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(MapleTokens.bg)
              .clipShape(RoundedRectangle(cornerRadius: MapleTokens.Radius.sm))
              .accessibilityIdentifier("general.settings.agentBridge.mcpConfig")

            Text(
              "Paste at top level of claude_desktop_config.json (or merge the \"maple\" entry into your existing mcpServers object). Requires maple-mcp built and linked in PATH or replaced with its absolute build path (see MapleMCP/README.md)."
            )
            .font(.caption2)
            .foregroundStyle(MapleTokens.textMuted)
          }
          .padding(.vertical, 2)
        }
      }
      .listRowBackground(MapleTokens.surface)
      .onChange(of: enabled) { _, newValue in
        controller.setEnabled(newValue)
      }
      .task(id: socketCopyGeneration) {
        guard socketCopyGeneration > 0 else { return }
        try? await Task.sleep(for: .seconds(2))
        guard !Task.isCancelled else { return }
        copiedSocket = false
      }
      .task(id: configCopyGeneration) {
        guard configCopyGeneration > 0 else { return }
        try? await Task.sleep(for: .seconds(2))
        guard !Task.isCancelled else { return }
        copiedConfig = false
      }
    }

    private func copyToClipboard(_ string: String) {
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(string, forType: .string)
    }

    @ViewBuilder
    private var status: some View {
      if let error = controller.lastError {
        Label {
          Text(error)
        } icon: {
          MuiIcon(name: "warning", size: .xs)
        }
        .font(.caption)
        .foregroundStyle(.orange)
      } else if controller.isListening {
        Label {
          Text("Listening for local agents")
        } icon: {
          MuiIcon(name: "check_circle", size: .xs)
        }
        .font(.caption)
        .foregroundStyle(MapleTokens.textMuted)
      }
    }
  }
#endif
