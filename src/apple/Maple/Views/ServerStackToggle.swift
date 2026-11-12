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
  /// Bumped by every read and flip, so only the newest one's answer lands in the view.
  @State private var generation = 0
  /// The value the server last confirmed, which a failed save puts the switch back to.
  @State private var saved = true

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
      saved = value
      isLoaded = true
      failure = nil
      await ServerRawJpegStackPreference.shared.record(value, server: server)
    } catch {
      guard current == generation else { return }
      failure = "Couldn't read this setting: \(error.localizedDescription)"
    }
  }

  /// Saves go through `ServerRawJpegStackPreference.save`, one at a time per server and latest
  /// wins: two flips before the first PUT finished used to send both at once, and the earlier one
  /// could reach the server last and keep the value the user had flipped away from.
  private func commit(_ value: Bool) {
    isOn = value
    generation &+= 1
    let current = generation
    let client = client
    Task { @MainActor in
      do {
        let sent = try await ServerRawJpegStackPreference.shared.save(value, server: server) {
          try await client.save(DisplayConfigPatch(stackRawJpeg: $0))
        }
        guard sent else { return }
        saved = value
        guard current == generation else { return }
        failure = nil
        NotificationCenter.default.post(name: RawJpegStackPreference.didChange, object: nil)
      } catch {
        guard current == generation else { return }
        isOn = saved
        failure = "Couldn't save this setting: \(error.localizedDescription)"
      }
    }
  }
}
