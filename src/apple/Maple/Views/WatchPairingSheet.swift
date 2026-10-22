#if os(iOS)
  import MapleUI
  import MapleCore
  import SwiftUI

  struct WatchPairingSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var pairing = WatchPhonePairing.shared
    @State private var selectedServer: URL?
    @State private var confirmReset = false

    var body: some View {
      NavigationStack {
        Form {
          Section {
            Label {
              Text("Maple on Apple Watch")
            } icon: {
              MuiIcon(name: "watch", size: .sm)
            }
            .font(.headline)
            Text(
              "Browse your recent photos and memories on your wrist. Your Watch gets its own connection to the server."
            )
            .foregroundStyle(.secondary)
          }
          if pairing.availableServers.isEmpty {
            Section {
              Text(
                "Sign in to a Maple Cloud server on this iPhone, then return to set up your Watch.")
            }
          } else if !pairing.completed {
            Section("Server") {
              Picker("Connect to", selection: $selectedServer) {
                Text("Choose a server").tag(nil as URL?)
                ForEach(pairing.availableServers, id: \.self) { server in
                  Text(
                    CloudServerRegistry.shared.displayName(for: server) ?? server.host
                      ?? server.absoluteString
                  )
                  .tag(server as URL?)
                }
              }
              .disabled(pairing.busy)
              .accessibilityLabel("Server for Apple Watch")
              Button("Allow Pairing") {
                if let selectedServer { pairing.allow(server: selectedServer) }
              }
              .disabled(selectedServer == nil || pairing.busy)
              .accessibilityLabel("Allow Apple Watch pairing")
            }
          }
          Section {
            if pairing.busy { ProgressView("Pairing Apple Watch") }
            if pairing.completed {
              Label {
                Text(pairing.message)
              } icon: {
                MuiIcon(name: "check_circle", size: .sm)
              }
            } else {
              Text(pairing.message)
            }
            if pairing.hasPendingAttempt && !pairing.completed {
              Button("Reset Pairing Attempt", role: .destructive) { confirmReset = true }
                .disabled(pairing.busy)
                .accessibilityLabel("Reset pending Apple Watch pairing")
            }
          } footer: {
            Text(
              "You can revoke Watch access in web Settings → Account. Closing this screen or signing out of your iPhone does not disconnect an already paired Watch."
            )
          }
        }
        .navigationTitle("Apple Watch")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .confirmationAction) {
            Button("Done") { dismiss() }
              .accessibilityLabel("Close Apple Watch setup")
          }
        }
        .confirmationDialog("Reset this pairing attempt?", isPresented: $confirmReset) {
          Button("Reset Pairing Attempt", role: .destructive) { pairing.resetAttempt() }
        } message: {
          Text(
            "A session may already exist on the server. Review paired devices in web Settings → Account and remove any abandoned Apple Watch session. Resetting here only clears the saved attempt on this iPhone."
          )
        }
      }
      .onAppear {
        pairing.open()
        selectedServer = pairing.availableServers.first
      }
      .onChange(of: selectedServer) { _, _ in
        if pairing.authorizedServer != nil { pairing.selectServer() }
      }
      .onDisappear { pairing.close() }
    }
  }
#endif
