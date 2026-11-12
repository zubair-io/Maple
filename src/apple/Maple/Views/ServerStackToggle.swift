// ServerStackToggle.swift — the 'Show one image for RAW+JPEG pairs' switch (#5050) for one
// Self Hosted server. The server keeps it as `stack_raw_jpeg` on `/api/display/config` (default
// on) and folds same-stem pairs in its folder listing; this row reads and writes that setting, then
// tells the open grid to reload.

import MapleCore
import SwiftUI

struct ServerStackToggle: View {
  let server: URL
  let session: AuthSession

  @State private var isOn = true
  @State private var isLoaded = false
  @State private var failure: String?

  private var client: DisplayConfigClient {
    DisplayConfigClient(
      server: server, httpClient: makeCloudHTTPClient(server: server, session: session))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Toggle(
        "Show one image for RAW+JPEG pairs",
        isOn: Binding(get: { isOn }, set: { commit($0) })
      )
      .disabled(!isLoaded)
      .font(.caption)
      .accessibilityIdentifier("cloud.stackRawJpeg.\(server.host ?? server.absoluteString)")
      if let failure {
        Text(failure)
          .font(.caption)
          .foregroundStyle(.red)
      }
    }
    .task(id: server) { await load() }
  }

  private func load() async {
    do {
      isOn = try await client.fetch().stackRawJpeg
      isLoaded = true
      failure = nil
    } catch {
      failure = "Couldn't read this setting: \(error.localizedDescription)"
    }
  }

  private func commit(_ value: Bool) {
    let previous = isOn
    isOn = value
    Task { @MainActor in
      do {
        try await client.save(DisplayConfigPatch(stackRawJpeg: value))
        failure = nil
        NotificationCenter.default.post(name: RawJpegStackPreference.didChange, object: nil)
      } catch {
        isOn = previous
        failure = "Couldn't save this setting: \(error.localizedDescription)"
      }
    }
  }
}
