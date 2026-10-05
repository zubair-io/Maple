#if os(macOS)
  import AppKit
  import MapleCore
  import MapleUI
  import SwiftUI

  /// One copyable prompt configures the app-owned local MCP connection.
  struct AgentBridgeSettingsSection: View {
    @State private var controller = AgentBridgeController.shared
    @AppStorage(AgentBridgeController.enabledDefaultsKey) private var enabled = false
    @State private var setupError: String?
    @State private var copied = false

    var body: some View {
      Section("AI Agents") {
        Toggle(isOn: $enabled) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Allow AI agents to work with Maple")
            Text("Browse, adjust, and export photos through a local connection on this Mac.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        .accessibilityIdentifier("general.settings.agentBridge")
        if enabled {
          status
          if controller.httpURL != nil {
            Button(copied ? "Setup prompt copied" : "Copy setup prompt") {
              do {
                guard let prompt = try controller.setupPrompt() else { return }
                NSPasteboard.general.clearContents()
                guard NSPasteboard.general.setString(prompt, forType: .string) else {
                  throw CocoaError(.fileWriteUnknown)
                }
                copied = true
                setupError = nil
              } catch {
                copied = false
                setupError = "Could not copy the setup prompt: \(error.localizedDescription)"
              }
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("general.settings.mcp.copyPrompt")
            Text("Paste this prompt into your AI tool to configure its connection to Maple.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Text("Keep Maple open while your AI tool uses it.")
            .font(.caption)
            .foregroundStyle(.secondary)
          if let setupError { Text(setupError).foregroundStyle(MapleTokens.errorText) }
        }
      }
      .listRowBackground(MapleTokens.surface)
      .onChange(of: enabled) { _, newValue in
        controller.setEnabled(newValue)
        setupError = nil
        copied = false
      }
      .onChange(of: controller.httpURL) { _, _ in copied = false }
    }

    @ViewBuilder
    private var status: some View {
      if let error = controller.httpError {
        Label {
          Text(error)
        } icon: {
          MuiIcon(name: "warning", size: .xs)
        }
        .font(.caption)
        .foregroundStyle(MapleTokens.errorText)
        Button("Retry") { controller.setEnabled(true) }
      } else if controller.isHTTPStarting {
        ProgressView("Starting MCP server…")
          .controlSize(.small)
      } else if controller.httpURL != nil {
        Label {
          Text("MCP server is running")
        } icon: {
          MuiIcon(name: "check_circle", size: .xs)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
      }
    }

  }
#endif
