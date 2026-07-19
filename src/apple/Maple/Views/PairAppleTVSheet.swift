// PairAppleTVSheet.swift
//
// Ticket #2082 (Maple TV epic, milestone C, task C4). iOS-only sheet
// presented from SelfHostedSettingsTab's "Pair Apple TV…" button — see
// TVQRScannerView.swift for why. Composes PairAppleTVViewModel's state
// machine (noServer / pickServer / scan / delivering / done / failed) into
// the five panels below, one per state.

#if os(iOS)
import SwiftUI
import MapleCore

struct PairAppleTVSheet: View {
  let onDismiss: () -> Void

  @State private var vm: PairAppleTVViewModel

  init(viewModel: PairAppleTVViewModel, onDismiss: @escaping () -> Void) {
    self._vm = State(wrappedValue: viewModel)
    self.onDismiss = onDismiss
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      header
      content
    }
    .padding(24)
    .frame(minHeight: 380)
  }

  private var header: some View {
    HStack {
      Text("Pair Apple TV")
        .font(.title3.weight(.semibold))
      Spacer()
      Button {
        onDismiss()
      } label: {
        Image(systemName: "xmark.circle.fill")
          .foregroundStyle(.secondary)
      }
      .accessibilityLabel("Close")
    }
  }

  @ViewBuilder
  private var content: some View {
    switch vm.state {
    case .noServer:
      noServerPanel
    case .pickServer:
      pickServerPanel
    case .scan:
      scanPanel
    case .delivering:
      deliveringPanel
    case .done(let deviceName):
      donePanel(deviceName: deviceName)
    case .failed(let message):
      failedPanel(message: message)
    }
  }

  // MARK: - Panels

  private var noServerPanel: some View {
    VStack(spacing: 12) {
      Image(systemName: "icloud.slash")
        .font(.system(size: 32))
        .foregroundStyle(.secondary)
      Text("Sign in to a Maple Cloud server first, then come back to pair your Apple TV.")
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
      Button("Close", action: onDismiss)
        .buttonStyle(.borderedProminent)
        .accessibilityLabel("Close pairing sheet")
    }
    .frame(maxWidth: .infinity, minHeight: 220)
  }

  private var pickServerPanel: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Which server should the Apple TV connect to?")
        .font(.callout)
        .foregroundStyle(.secondary)
      ForEach(vm.availableServers, id: \.self) { server in
        let label = server.host ?? server.absoluteString
        Button {
          vm.selectServer(server)
        } label: {
          HStack {
            Image(systemName: "server.rack")
            Text(label)
            Spacer()
            Image(systemName: "chevron.right")
              .foregroundStyle(.secondary)
          }
          .padding(10)
          .background(MapleTokens.surface, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Pair with \(label)")
      }
    }
  }

  private var scanPanel: some View {
    VStack(alignment: .leading, spacing: 12) {
      deviceNameField
      TVQRScannerView { payload in
        Task { await vm.pair(payload: payload) }
      }
    }
  }

  private var deviceNameField: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Name this Apple TV")
        .font(.caption)
        .foregroundStyle(.secondary)
      TextField("Apple TV", text: $vm.deviceName)
        .textFieldStyle(.roundedBorder)
        .accessibilityLabel("Apple TV device name")
    }
  }

  private var deliveringPanel: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text("Pairing with your Apple TV…")
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, minHeight: 220)
  }

  private func donePanel(deviceName: String) -> some View {
    VStack(spacing: 12) {
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 40))
        .foregroundStyle(.green)
      Text("Paired with \(deviceName)")
        .font(.headline)
      Button("Done", action: onDismiss)
        .buttonStyle(.borderedProminent)
        .accessibilityLabel("Finish pairing")
    }
    .frame(maxWidth: .infinity, minHeight: 220)
  }

  private func failedPanel(message: String) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(message, systemImage: "exclamationmark.triangle.fill")
        .foregroundStyle(.red)
        .font(.callout)
        .multilineTextAlignment(.leading)
      HStack {
        Spacer()
        Button("Cancel", action: onDismiss)
          .accessibilityLabel("Cancel pairing")
        Button("Try Again") { vm.retry() }
          .buttonStyle(.borderedProminent)
          .accessibilityLabel("Retry pairing")
      }
    }
    .frame(minHeight: 220)
  }
}

// MARK: - Previews

#Preview("No signed-in server") {
  PairAppleTVSheet(
    viewModel: PairAppleTVViewModel(registry: CloudServerRegistry(defaults: .init(suiteName: "preview.pairtv.none")!)),
    onDismiss: {}
  )
}
#endif
