// ServerStackToggle.swift — the 'Show one image for RAW+JPEG pairs' switch (#5050) for one
// Self Hosted server. The server keeps it as `stack_raw_jpeg` on `/api/display/config` (default
// on) as the user's preference; the grid, Timeline and search read it and ask for folded results
// with `stack=1`. This row reads and writes that setting, then tells the open grid to reload.

import MapleCore
import SwiftUI

struct ServerStackToggle: View {
  let server: URL
  let session: AuthSession

  @State private var isOn = true
  @State private var isLoaded = false
  @State private var failure: String?
  /// Bumped by every read and save, so only the newest one's answer lands (a slow save of an
  /// earlier flip can never overwrite a later one).
  @State private var generation = 0

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
    generation &+= 1
    let current = generation
    do {
      let value = try await client.fetch().stackRawJpeg
      guard current == generation else { return }
      isOn = value
      isLoaded = true
      failure = nil
      await ServerRawJpegStackPreference.shared.record(value, server: server)
    } catch {
      guard current == generation else { return }
      failure = "Couldn't read this setting: \(error.localizedDescription)"
    }
  }

  private func commit(_ value: Bool) {
    let previous = isOn
    isOn = value
    generation &+= 1
    let current = generation
    Task { @MainActor in
      do {
        try await client.save(DisplayConfigPatch(stackRawJpeg: value))
        guard current == generation else { return }
        failure = nil
        await ServerRawJpegStackPreference.shared.record(value, server: server)
        NotificationCenter.default.post(name: RawJpegStackPreference.didChange, object: nil)
      } catch {
        guard current == generation else { return }
        isOn = previous
        failure = "Couldn't save this setting: \(error.localizedDescription)"
      }
    }
  }
}
