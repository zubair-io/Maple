// FacePurgePanel.swift — sub-threshold face cleanup subsection of the
// face-detect row (T5b, #2772). Mirrors FacePurgePanelComponent
// (src/web/.../workers/face-purge-panel.component.ts).
//
// Audit-first: an Audit button runs the read-only dry-run scan and shows the
// breakdown (unassigned / assigned / hidden). Apply is enabled only once an
// audit has run AND found something removable for the current opt-in state
// — the ticket's own acceptance criterion ("Apply should not be reachable
// without having run the audit"). By default Apply removes only unassigned
// faces; the checkbox opts in to also removing tiny faces assigned to a
// person (hand-labeled or auto-grouping — indistinguishable). Hidden faces
// are always preserved server-side.
//
// This does NOT re-detect — it only removes faces whose bbox already fell
// below the configured threshold, without touching any other face's
// person_id.

import SwiftUI
import MapleCore
import MapleUI

struct FacePurgePanel: View {
    let client: FacePurgeClient

    private enum PanelState: Equatable { case idle, auditing, applying }

    @State private var state: PanelState = .idle
    @State private var audit: SubthresholdFaceResult?
    @State private var lastApplied: SubthresholdFaceApplyResult?
    @State private var error: String?
    @State private var includeAssigned = false
    @State private var confirmingApply = false

    private var busy: Bool { state != .idle }

    private var removableCount: Int {
        audit?.removableCount(includeAssigned: includeAssigned) ?? 0
    }

    private var canApply: Bool { !busy && removableCount > 0 }

    private var confirmApplyPrompt: String {
        includeAssigned
            ? "Remove \(removableCount) tiny faces assigned to people? This includes faces "
                + "you may have labeled by hand and can't be undone without a full re-detect."
            : "Remove \(removableCount) unassigned tiny faces? This cannot be undone without "
                + "a full re-detect."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("SUB-THRESHOLD FACE CLEANUP")
                .font(.caption2)
                .foregroundStyle(.secondary)

            if let audit {
                VStack(alignment: .leading, spacing: 2) {
                    // Built as plain `String` locals, not inline in `Text(...)`: a
                    // string literal passed directly to `Text` infers
                    // `LocalizedStringKey`, and `+`-concatenating interpolated
                    // literals in that context resolves to the wrong `+` overload
                    // (RangeReplaceableCollection's) and fails to compile.
                    let thresholdLine: String =
                        "Threshold \(String(format: "%.2f", audit.threshold)) · "
                        + "\(audit.subThresholdFaces.total) tiny faces across "
                        + "\(audit.assetsAffected) of \(audit.assetsScanned) assets scanned"
                    let breakdownLine: String =
                        "\(audit.subThresholdFaces.unassigned) unassigned · "
                        + "\(audit.subThresholdFaces.assigned) assigned · "
                        + "\(audit.subThresholdFaces.hidden) hidden (always kept)"
                    Text(thresholdLine).font(.caption)
                    Text(breakdownLine).font(.caption).foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("workers.facePurge.audit")
            }

            if let applied = lastApplied {
                MuiStatusText(
                    state: .saved,
                    text: "Removed \(applied.facesRemoved) faces across \(applied.assetsUpdated) assets."
                )
                .accessibilityIdentifier("workers.facePurge.applied")
            }

            MuiCheckbox(
                state: includeAssigned ? .checked : .unchecked,
                label: "Also remove tiny faces assigned to a person",
                disabled: busy,
                action: { includeAssigned.toggle() }
            )
            .accessibilityIdentifier("workers.facePurge.includeAssigned")

            HStack(spacing: 8) {
                MuiButton(
                    label: "Audit", variant: .secondary, isLoading: state == .auditing,
                    disabled: busy,
                    action: { Task { await runAudit() } }
                )
                .accessibilityIdentifier("workers.facePurge.audit.run")

                MuiButton(
                    label: "Apply", variant: .primary, isLoading: state == .applying,
                    disabled: !canApply,
                    action: { confirmingApply = true }
                )
                .accessibilityIdentifier("workers.facePurge.apply")
            }

            if let error {
                MuiStatusText(state: .error, text: error)
                    .accessibilityIdentifier("workers.facePurge.error")
            }
        }
        .confirmationDialog(
            confirmApplyPrompt,
            isPresented: $confirmingApply,
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) { Task { await apply() } }
            Button("Cancel", role: .cancel) {}
        }
    }

    // @MainActor because a SwiftUI View is not globally actor-isolated in
    // Swift 5 mode and `.task` takes a @Sendable closure, so an unannotated
    // async method mutating @State would publish from the cooperative pool.
    @MainActor
    private func runAudit(preserveApplied: Bool = false) async {
        guard !busy else { return }
        state = .auditing
        error = nil
        if !preserveApplied { lastApplied = nil }
        do {
            audit = try await client.audit()
        } catch {
            self.error = error.localizedDescription
            audit = nil
        }
        state = .idle
    }

    @MainActor
    private func apply() async {
        guard canApply else { return }
        state = .applying
        error = nil
        do {
            let result = try await client.apply(includeAssigned: includeAssigned)
            lastApplied = result.applied
            // Re-run the audit so the breakdown reflects the post-purge
            // state, keeping the success summary visible.
            state = .idle
            await runAudit(preserveApplied: true)
        } catch {
            self.error = error.localizedDescription
            state = .idle
        }
    }
}
