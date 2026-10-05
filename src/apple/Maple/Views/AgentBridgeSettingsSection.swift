#if os(macOS)
  import MapleCore
  import MapleUI
  import SwiftUI
  import AppKit
  import UniformTypeIdentifiers

  /// The app-owned MCP endpoint and complete local client setup.
  struct AgentBridgeSettingsSection: View {
    @State private var controller = AgentBridgeController.shared
    @AppStorage(AgentBridgeController.enabledDefaultsKey) private var enabled = false
    @State private var port = ""
    @State private var setupError: String?
    @State private var exportDocument: MCPBundleDocument?
    @State private var exporting = false
    @State private var exportGeneration = 0

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
          if let url = controller.httpURL, let token = controller.authorizationToken {
            connectionSetup(url: url, token: token)
          }
          HStack {
            TextField("Port", text: $port)
              .textFieldStyle(.roundedBorder)
              .frame(width: 90)
              .accessibilityIdentifier("general.settings.mcp.port")
            Button("Apply port") {
              if let value = Int(port) { controller.updateHTTPPort(value) }
            }
            .disabled(
              Int(port).map { !(1024...65535).contains($0) || $0 == controller.httpPort } ?? true)
          }
          Text("Keep Maple open while your client uses MCP. Connections stay on this Mac.")
            .font(.caption)
            .foregroundStyle(.secondary)
          if let setupError { Text(setupError).foregroundStyle(MuiTokens.errorText) }
        }
      }
      .listRowBackground(MapleTokens.surface)
      .onChange(of: enabled) { _, newValue in
        controller.setEnabled(newValue)
        setupError = nil
      }
      .onAppear { port = String(controller.httpPort) }
      .onDisappear { exportGeneration &+= 1 }
      .fileExporter(
        isPresented: $exporting, document: exportDocument,
        contentType: UTType(filenameExtension: "mcpb") ?? .data,
        defaultFilename: "Maple.mcpb"
      ) { result in
        if case .failure(let error) = result { setupError = error.localizedDescription }
      }
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
        .foregroundStyle(MuiTokens.errorText)
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

    private func connectionSetup(url: URL, token: String) -> some View {
      VStack(alignment: .leading, spacing: 10) {
        LabeledContent("Server URL") {
          Text(url.absoluteString).textSelection(.enabled)
        }
        .accessibilityIdentifier("general.settings.mcp.url")
        HStack {
          Button("Copy URL") { copy(url.absoluteString) }
          Button("Copy access token") { copy(token) }
        }
        HStack {
          Button("Copy Codex configuration") {
            if let config = controller.codexConfiguration() { copy(config) }
          }
          .accessibilityIdentifier("general.settings.mcp.copyCodex")
          Button("Copy Cursor configuration") {
            do {
              if let config = try controller.cursorConfiguration() { copy(config) }
            } catch { setupError = error.localizedDescription }
          }
          .accessibilityIdentifier("general.settings.mcp.copyCursor")
        }
        Text(
          "Add the Codex configuration to ~/.codex/config.toml, or the Cursor configuration to ~/.cursor/mcp.json. Both include the access token."
        )
        .font(.caption).foregroundStyle(.secondary)
        Button("Save Claude Desktop extension…", action: saveClaudeExtension)
          .accessibilityIdentifier("general.settings.mcp.claudeExtension")
        Text(
          "In Claude Desktop, open Settings → Extensions → Advanced settings → Install Extension. Select Maple.mcpb, then enter the server URL and access token above."
        )
        .font(.caption).foregroundStyle(.secondary)
      }
      .buttonStyle(.bordered)
    }

    private func copy(_ text: String) {
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    }

    private func saveClaudeExtension() {
      guard let url = AgentBridgeController.claudeExtensionURL else {
        setupError = "The Claude Desktop extension is missing from this build."
        return
      }
      exportGeneration &+= 1
      let generation = exportGeneration
      Task {
        do {
          let data = try await Task.detached { try Data(contentsOf: url) }.value
          guard generation == exportGeneration else { return }
          exportDocument = MCPBundleDocument(data: data)
          exporting = true
        } catch {
          guard generation == exportGeneration else { return }
          setupError = error.localizedDescription
        }
      }
    }
  }

  private struct MCPBundleDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.data]
    let data: Data

    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
      guard let data = configuration.file.regularFileContents else {
        throw CocoaError(.fileReadCorruptFile)
      }
      self.data = data
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
      FileWrapper(regularFileWithContents: data)
    }
  }
#endif
