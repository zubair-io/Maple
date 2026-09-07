import MapleCore
import SwiftUI

struct BatchAdjustmentProgressView: View {
  @Bindable var controller: BatchAdjustmentController
  let library: BatchAdjustmentLibrary?
  @State private var showsHistory = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let id = controller.activeID {
        HStack {
          if let progress = controller.progress {
            ProgressView(value: Double(progress.processed), total: Double(progress.total))
              .frame(maxWidth: 160)
            Text("\(progress.applied) saved · \(progress.failed) failed · \(progress.total) photos")
          } else {
            ProgressView("Preparing settings transfer…")
          }
          Spacer()
          Button(controller.isCancelling ? "Stopping…" : "Cancel") {
            Task { await controller.cancel(id) }
          }.disabled(controller.isCancelling)
            .accessibilityIdentifier("batch-transfer-cancel")
        }
      }
      if let error = controller.error {
        HStack {
          Text(error).foregroundStyle(.red)
          Button("Dismiss") { controller.error = nil }
        }
      }
      if !controller.operations.isEmpty {
        DisclosureGroup(
          "Saved settings transfers (\(controller.operations.count))", isExpanded: $showsHistory
        ) {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
              ForEach(controller.operations, id: \.operation.id) { snapshot in
                operationRow(snapshot)
              }
            }
          }.frame(maxHeight: 220)
        }
        .accessibilityIdentifier("batch-transfer-history")
      }
    }
    .font(.caption)
    .padding(
      controller.activeID != nil || controller.error != nil || !controller.operations.isEmpty
        ? 10 : 0
    )
    .task(id: library?.id) { await controller.refresh(scopeID: library?.id) }
  }

  private func operationRow(_ snapshot: BatchAdjustmentSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(snapshot.operation.createdAt, style: .date).fontWeight(.semibold)
      Text(
        "\(snapshot.summary.applied.count) saved · \(snapshot.summary.failed.count) failed · \(snapshot.pendingCount) remaining"
      )
      if snapshot.summary.cancelled { Text("Cancelled. Saved photos keep their changes.") }
      if !snapshot.summary.failed.isEmpty {
        DisclosureGroup("Failed photos (\(snapshot.summary.failed.count))") {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
              ForEach(snapshot.summary.failed, id: \.id) { failure in
                let name =
                  snapshot.operation.targets.first(where: { $0.id == failure.id })?.name
                  ?? failure.id
                Text("\(name): \(failure.reason)").foregroundStyle(.red)
              }
            }
          }.frame(maxHeight: 160)
        }
      }
      HStack {
        if snapshot.pendingCount > 0 {
          Button("Resume") { run(snapshot, retryFailed: false) }
            .accessibilityIdentifier("batch-transfer-resume")
        }
        if !snapshot.summary.failed.isEmpty {
          Button("Retry Failed") { run(snapshot, retryFailed: true) }
            .accessibilityIdentifier("batch-transfer-retry-failed")
        }
        Button("Dismiss") { Task { await controller.dismiss(snapshot.operation.id) } }
          .accessibilityIdentifier("batch-transfer-dismiss")
      }
      .disabled(controller.activeID != nil || library == nil)
    }
  }

  private func run(_ snapshot: BatchAdjustmentSnapshot, retryFailed: Bool) {
    guard let library else { return }
    Task {
      await controller.run(
        operation: snapshot.operation, library: library, retryFailed: retryFailed)
    }
  }
}
