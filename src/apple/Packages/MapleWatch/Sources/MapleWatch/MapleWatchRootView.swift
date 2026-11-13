import MapleCloudKit
import SwiftUI

/// Watch app shell: phone-assisted setup followed by direct server browsing.
@MainActor
public struct MapleWatchRootView: View {
  @State private var pairing = WatchPairingClient.shared
  @Environment(\.scenePhase) private var scenePhase

  public init() {}

  public var body: some View {
    Group {
      if let server = pairing.server {
        MapleWatchLibraryView(server: server) { pairing.disconnect() }
          .id(server)
      } else {
        NavigationStack {
          ScrollView {
            VStack(alignment: .leading, spacing: 10) {
              Text("Connect your photos")
                .font(.headline)
              if let message = pairing.message {
                Text(message).font(.caption2).accessibilityIdentifier("watch.pairing.message")
              }
              if pairing.isConnecting {
                ProgressView("Connecting")
                Button("Cancel") { pairing.cancel() }
              } else {
                Button("Connect to iPhone") { pairing.connect() }
                  .accessibilityIdentifier("watch.pairing.connect")
              }
              Text(
                "First, allow pairing in Maple on iPhone: Settings → Self Hosted → Connect Apple Watch."
              )
              .font(.caption2)
            }
            .padding(.horizontal, 8)
          }
          .navigationTitle("Maple")
          .toolbarTitleDisplayMode(.inline)
        }
      }
    }
    .task { pairing.start() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { pairing.start() }
    }
  }
}
