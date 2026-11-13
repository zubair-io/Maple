// TemporalSettingsSection.swift — the "Job server" section of the Workers
// page (#5826). Mirrors TemporalSettingsComponent
// (src/web/.../workers/temporal-settings.component.ts); loading, polling and
// saving live in TemporalSettingsModel.

import MapleCore
import MapleUI
import SwiftUI

struct TemporalSettingsSection: View {
  @State private var model: TemporalSettingsModel

  init(client: WorkersAdminClient) {
    _model = State(initialValue: TemporalSettingsModel(client: client))
  }

  var body: some View {
    Section("Job server") {
      // Lifecycle modifiers sit on this one row, not on the Section: inside a
      // Form a Section's modifiers are applied to each of its rows, which
      // would start one polling loop per row.
      Text(
        "Maple runs its background jobs on a Temporal server, and this is where it finds that server."
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      .onAppear { model.start() }
      .onDisappear { model.stop() }

      if let settings = model.settings {
        loadedBody(settings)
      } else if let loadError = model.loadError {
        MuiBanner(
          variant: .error, message: "Failed to load Temporal settings: \(loadError)",
          actionLabel: "Retry", actionPressed: { model.retry() }
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
  }

  @ViewBuilder
  private func loadedBody(_ settings: TemporalSettings) -> some View {
    LabeledContent("Address") {
      MuiInput(
        value: $model.address, accessibilityLabel: "Temporal address",
        placeholder: "127.0.0.1:7233", monospaced: true, autocorrectionDisabled: true
      )
      .accessibilityIdentifier("workers.temporal.address")
    }

    Text("Host and port of the Temporal frontend.")
      .font(.caption)
      .foregroundStyle(.secondary)

    LabeledContent("Namespace") {
      MuiInput(
        value: $model.namespace, accessibilityLabel: "Temporal namespace",
        placeholder: "default", monospaced: true, autocorrectionDisabled: true
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

    Text(settings.connectionDetail)
      .font(.caption)
      .foregroundStyle(.secondary)
      .accessibilityIdentifier("workers.temporal.connectionDetail")

    serverAdminActionButton(
      "Save changes", variant: .primary, state: actionState, successText: "Saved.",
      identifier: "workers.temporal.save",
      disabled: !model.canSave,
      action: { Task { await model.save() } }
    )
  }

  private var actionState: ServerAdminActionState {
    switch model.saveState {
    case .idle: return .idle
    case .running: return .running
    case .succeeded: return .succeeded
    case .failed(let message): return .failed(message)
    }
  }

  private func toneColor(_ state: TemporalConnectionState) -> Color {
    switch state {
    case .connected: return .green
    case .unreachable: return .red
    case .unknown: return .orange
    }
  }
}
