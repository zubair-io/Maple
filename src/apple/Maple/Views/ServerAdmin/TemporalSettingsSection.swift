// TemporalSettingsSection.swift — the "Job server" section of the Workers
// page (#5826). Mirrors TemporalSettingsComponent
// (src/web/.../workers/temporal-settings.component.ts): where the server
// finds Temporal, whether the worker tier can reach it, and — for the owner
// only — a form to point it somewhere else.
//
// Polling: every 2 s while the worker tier has not reported on the saved
// target, then every 10 s (`TemporalSettings.nextPollDelay`). A save restarts
// the watch so the faster cadence applies straight away.

import MapleCore
import MapleUI
import SwiftUI

struct TemporalSettingsSection: View {
  let client: WorkersAdminClient
  let isOwner: Bool

  @State private var form = TemporalSettingsForm()
  @State private var loadError: String?
  @State private var saveState: ServerAdminActionState = .idle
  @State private var watchEpoch = 0

  var body: some View {
    Section("Job server") {
      Text(
        "Maple runs its background jobs on a Temporal server, and this is where it finds that server."
      )
      .font(.caption)
      .foregroundStyle(.secondary)

      if let settings = form.settings {
        loadedBody(settings)
      } else if let loadError {
        MuiBanner(
          variant: .error, message: "Failed to load Temporal settings: \(loadError)",
          actionLabel: "Retry",
          actionPressed: {
            self.loadError = nil
            watchEpoch += 1
          }
        )
        .accessibilityIdentifier("workers.temporal.loadError")
      } else {
        HStack {
          Text("Loading…").foregroundStyle(.secondary)
          Spacer()
          ProgressView().controlSize(.small)
        }
      }
    }
    .listRowBackground(MapleTokens.surface)
    .task(id: watchEpoch) { await watch() }
    .onChange(of: form.target) {
      if saveState == .succeeded { saveState = .idle }
    }
  }

  @ViewBuilder
  private func loadedBody(_ settings: TemporalSettings) -> some View {
    LabeledContent("Address") {
      MuiInput(
        value: $form.address, accessibilityLabel: "Temporal address",
        placeholder: "127.0.0.1:7233", readOnly: !isOwner, monospaced: true,
        autocorrectionDisabled: true
      )
      .accessibilityIdentifier("workers.temporal.address")
    }

    Text("Host and port of the Temporal frontend.")
      .font(.caption)
      .foregroundStyle(.secondary)

    LabeledContent("Namespace") {
      MuiInput(
        value: $form.namespace, accessibilityLabel: "Temporal namespace",
        placeholder: "default", readOnly: !isOwner, monospaced: true,
        autocorrectionDisabled: true
      )
      .accessibilityIdentifier("workers.temporal.namespace")
    }

    LabeledContent("Connection") {
      HStack(spacing: 5) {
        Circle()
          .fill(toneColor(settings.connection.state))
          .frame(width: 7, height: 7)
          .accessibilityHidden(true)
        Text(settings.connection.label)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("workers.temporal.connection")

    if let detail = settings.connection.detail {
      Text(detail)
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("workers.temporal.connectionDetail")
    }

    if isOwner {
      serverAdminActionButton(
        "Save changes", variant: .primary, state: saveState, successText: "Saved.",
        identifier: "workers.temporal.save",
        disabled: form.target == nil,
        action: { Task { await save() } }
      )
    } else {
      Text("Only the server owner can change where Maple finds Temporal.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("workers.temporal.ownerOnly")
    }
  }

  private func toneColor(_ state: TemporalConnectionState) -> Color {
    switch state {
    case .connected: return .green
    case .unreachable: return .red
    case .unknown: return .orange
    }
  }

  // @MainActor — see WorkersSettingsView's note: `.task` takes a @Sendable
  // closure, so these would otherwise publish @State from the cooperative pool.

  @MainActor
  private func watch() async {
    if form.settings == nil {
      let token = form.generation
      do {
        form.adopt(try await client.temporal(), token: token)
      } catch {
        if !Task.isCancelled { loadError = error.localizedDescription }
        return
      }
    }
    while let settings = form.settings {
      do { try await Task.sleep(for: settings.nextPollDelay) } catch { return }
      // A read issued mid-save could return the old target's state after the
      // save's own response has landed.
      guard saveState != .running else { continue }
      let token = form.generation
      if let next = try? await client.temporal() { form.adopt(next, token: token) }
    }
  }

  @MainActor
  private func save() async {
    guard isOwner, let target = form.target, saveState != .running else { return }
    let token = form.beginSave()
    saveState = .running
    do {
      form.adopt(try await client.saveTemporal(target), token: token)
      saveState = .succeeded
    } catch {
      saveState = .failed(error.localizedDescription)
    }
    watchEpoch += 1
  }
}
