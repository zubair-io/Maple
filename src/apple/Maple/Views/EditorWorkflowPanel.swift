import MapleCore
import MapleUI
import SwiftUI

/// Actual portable checkpoints; the session owns confirmed writes and Undo (#4062).
struct EditorWorkflowPanel: View {
  let session: EditSession
  @Environment(\.dismiss) private var dismiss
  @State private var snapshotPrompt = false
  @State private var snapshotName = ""
  @State private var variantPrompt = false
  @State private var variantName = ""

  private var workflow: EditorWorkflowState { session.workflow }

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
        MuiText(
          "Restore saved edits and metadata. Undo returns to your previous checkpoint.",
          variant: .body, color: .muted, block: true
        )
        .fixedSize(horizontal: false, vertical: true)
        if let error = workflow.errorText, !snapshotPrompt, !variantPrompt,
          workflow.pendingRestoreLabel == nil
        {
          MuiText(error, variant: .body, color: .error, block: true)
            .accessibilityIdentifier("workflow-error")
        }
        if workflow.isBusy {
          MuiSpinner(placement: .centered, label: "Saving or loading checkpoints")
            .accessibilityIdentifier("workflow-busy")
        }
        ScrollView {
          LazyVStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            HStack {
              MuiText("Variants", variant: .rowLabel, block: true)
              Spacer()
              MuiButton(label: "New variant", variant: .ghost, disabled: workflow.isBusy) {
                variantName = ""
                variantPrompt = true
              }
              .accessibilityIdentifier("workflow-new-variant")
            }
            ForEach(workflow.variants, id: \.variantId) { variant in
              variantRow(variant)
            }
            if workflow.record?.snapshots.isEmpty != false
              && workflow.record?.history.isEmpty != false
            {
              MuiEmptyState(
                icon: "history", title: "No saved history yet",
                message: "Save a named snapshot of your current edits."
              )
              .accessibilityIdentifier("workflow-empty")
            }
            if let record = workflow.record {
              MuiText("Snapshots", variant: .rowLabel, block: true)
              ForEach(record.snapshots, id: \.id) { snapshot in
                checkpointRow(
                  id: snapshot.id, label: snapshot.name, timestamp: snapshot.createdAtMs,
                  snapshot: true)
              }
              MuiText("History", variant: .rowLabel, block: true)
              ForEach(record.history.reversed(), id: \.id) { entry in
                checkpointRow(
                  id: entry.id, label: entry.label, timestamp: entry.createdAtMs, snapshot: false)
              }
            }
          }
        }
      }
      .padding(MuiTokens.spacingMd)
      .background(MuiTokens.surface)
      .safeAreaInset(edge: .bottom) {
        HStack {
          MuiButton(label: "Refresh", variant: .ghost, disabled: workflow.isBusy) {
            Task { await workflow.reload(session: session) }
          }
          .accessibilityIdentifier("workflow-refresh")
          Spacer()
          MuiButton(
            label: "Save snapshot", variant: .primary,
            disabled: workflow.isBusy || !workflow.isSupported(session: session)
          ) {
            snapshotName = ""
            snapshotPrompt = true
          }
          .accessibilityIdentifier("workflow-save-snapshot")
        }
        .padding(MuiTokens.spacingMd)
        .background(MuiTokens.surface)
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          MuiButton(
            label: "Close", variant: .ghost, leadingIcon: "close", iconOnly: true,
            disabled: workflow.isBusy
          ) { dismiss() }
          .accessibilityIdentifier("workflow-close")
        }
      }
      .navigationTitle("Snapshots and history")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
    }
    .disabled(snapshotPrompt || variantPrompt || workflow.pendingRestoreLabel != nil)
    .accessibilityHidden(snapshotPrompt || variantPrompt || workflow.pendingRestoreLabel != nil)
    #if os(macOS)
      .frame(width: 480, height: 520)
    #endif
    .overlay {
      MuiDialog(
        isPresented: variantPrompt, title: "New variant",
        message: workflow.errorText ?? "Start a separate edit from the current variant.",
        variant: .prompt, confirmLabel: "Create", promptPlaceholder: "Variant name",
        promptValue: $variantName,
        confirmed: { _ in
          let name = variantName
          Task {
            await workflow.createVariant(name: name, session: session)
            if workflow.errorText == nil { variantPrompt = false }
          }
        },
        dismissed: { variantPrompt = false }
      )
      .disabled(workflow.isBusy)
    }
    .overlay {
      MuiDialog(
        isPresented: snapshotPrompt, title: "Save snapshot",
        message: workflow.errorText ?? "This keeps your complete current edits and metadata.",
        variant: .prompt, confirmLabel: "Save", promptPlaceholder: "Snapshot name",
        promptValue: $snapshotName,
        confirmed: { _ in
          let name = snapshotName
          Task {
            await workflow.saveSnapshot(name: name, session: session)
            if workflow.errorText == nil { snapshotPrompt = false }
          }
        },
        dismissed: {
          snapshotPrompt = false
          workflow.cancelRestore()
        }
      )
      .disabled(workflow.isBusy)
    }
    .overlay {
      MuiDialog(
        isPresented: workflow.pendingRestoreLabel != nil,
        title: "Restore \(workflow.pendingRestoreLabel ?? "checkpoint")?",
        message: workflow.errorText
          ?? "This replaces your edits and metadata. You can Undo this restore.",
        confirmLabel: "Restore",
        confirmed: { _ in Task { await workflow.confirmRestore(session: session) } },
        dismissed: { workflow.cancelRestore() }
      )
      .disabled(workflow.isBusy)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-workflow-panel")
    .interactiveDismissDisabled(workflow.isBusy)
    .task { await workflow.reload(session: session) }
    .onDisappear { workflow.cancelRestore() }
  }

  private func variantRow(_ variant: WorkflowVariantSidecar) -> some View {
    let name = variant.workflow?.variantName ?? "Primary"
    let selected = workflow.selectedVariantId == variant.variantId
    return MuiListRow(
      label: name, disabled: workflow.isBusy || selected,
      pressed: { Task { await workflow.selectVariant(variant.variantId, session: session) } },
      trailing: {
        MuiText(selected ? "Selected" : "Use", variant: .toolLabel, color: .muted, truncate: true)
      }
    )
    .accessibilityLabel("\(selected ? "Selected variant" : "Use variant") \(name)")
    .accessibilityIdentifier("workflow-select-\(variant.variantId)")
  }

  private func checkpointRow(id: String, label: String, timestamp: UInt64, snapshot: Bool)
    -> some View
  {
    MuiListRow(
      label: label, timestampValue: Date(timeIntervalSince1970: Double(timestamp) / 1000),
      disabled: workflow.isBusy,
      pressed: { workflow.prepareRestore(id: id, snapshot: snapshot) },
      trailing: {
        MuiText("Restore", variant: .toolLabel, color: .muted, truncate: true)
      }
    )
    .accessibilityLabel("Restore \(label)")
    .accessibilityIdentifier("workflow-restore-\(id)")
  }
}
