// BatchMetadataSheet.swift — top-level sheet for the Batch Metadata editor.
// Presented as a modal sheet from AppShell when the user taps "Edit Metadata…"
// in the PanoSelectionBar. Hosts the two content sections + toolbar.
//
// Ticket #1629 / epic #1575.

import SwiftUI
import MapleCore

// MARK: - BatchMetadataSheet

struct BatchMetadataSheet: View {
    @Bindable var vm: BatchMetadataViewModel
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading {
                    ProgressView("Loading…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    content
                }
            }
            .navigationTitle(navigationTitle)
            .toolbar { toolbar }
        }
        .task { await vm.loadExistingMetadata() }
        .alert("Some assets could not be updated",
               isPresented: Binding(
                   get: { vm.applyError != nil },
                   set: { if !$0 { vm.clearApplyError() } }
               ),
               presenting: vm.applyError) { _ in
            Button("OK", role: .cancel) {}
        } message: { err in
            if case .partialFailure(let pairs) = err {
                Text("\(pairs.count) asset(s) failed to update. Successfully written assets are not rolled back.")
            }
        }
    }

    // MARK: - Content

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                BatchMetadataCaptureSection(vm: vm)
                Divider()
                BatchMetadataTextSection(vm: vm)
            }
            .padding(.bottom, 24)
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { onDismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
            Button("Apply") {
                Task {
                    do {
                        try await vm.apply()
                        if vm.applyError == nil { onDismiss() }
                    } catch {
                        // Expected on partial failure: apply() records `applyError`
                        // (which drives the alert) and rethrows. Keep the sheet open.
                        // Only a throw WITHOUT a recorded error would be a bug.
                        assert(vm.applyError != nil,
                               "vm.apply() threw without recording applyError: \(error)")
                    }
                }
            }
            .disabled(!vm.touchedMetadata.hasTouched)
        }
    }

    // MARK: - Helpers

    private var navigationTitle: String {
        let count = vm.assets.count
        return count == 1 ? "Edit Metadata" : "Edit Metadata (\(count) photos)"
    }
}

// MARK: - Preview

#Preview {
    BatchMetadataSheet(
        vm: {
            let assets = (0..<3).map { i in
                AssetRef(url: URL(fileURLWithPath: "/tmp/test_\(i).dng"))
            }
            return BatchMetadataViewModel(assets: assets, sessions: [:])
        }(),
        onDismiss: {}
    )
}
