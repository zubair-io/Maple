// BatchRenameSheet.swift — top-level sheet for the Batch Rename dialog
// (#2641, design doc § "Rename" — batch: template-token modal, live
// before/after preview, applied sequentially).
//
// Mirrors BatchMetadataSheet.swift's shape (toolbar Cancel/Apply,
// NavigationStack, VM held in AppShell's @State so a re-render can't
// discard in-progress work).

import SwiftUI
import MapleCore

// MARK: - BatchRenameSheet

struct BatchRenameSheet: View {
    @Bindable var vm: BatchRenameViewModel
    let onDismiss: () -> Void

    /// Debounce key for `.task(id:)` — a changed template/sequence value
    /// cancels the in-flight debounce Task and starts a fresh one, so
    /// Cloud's network round trip doesn't fire on every keystroke. Local
    /// (Filesystem/SMB) preview is cheap enough that the debounce costs it
    /// nothing beyond the fixed delay.
    private var debounceKey: String {
        "\(vm.template)|\(vm.sequenceStart)|\(vm.sequencePadWidth)"
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if case .unsupported(let reason) = vm.routing {
                    unsupportedBanner(reason)
                }
                BatchRenameTemplateSection(vm: vm)
                Divider()
                BatchRenamePreviewList(vm: vm)
            }
            .navigationTitle(navigationTitle)
            .toolbar { toolbar }
        }
        .task(id: debounceKey) {
            // 300ms debounce: `.task(id:)` cancels the previous instance of
            // this Task the moment `debounceKey` changes, so a superseded
            // keystroke's `Task.sleep` is cancelled before it ever calls
            // `refreshPreview()` — a network round trip (Cloud routing)
            // never fires more than once per pause in typing.
            do {
                try await Task.sleep(for: .milliseconds(300))
            } catch {
                return
            }
            await vm.refreshPreview()
        }
    }

    // MARK: - Unsupported banner

    private func unsupportedBanner(_ reason: String) -> some View {
        Text(reason)
            .font(.callout)
            .foregroundStyle(MapleTokens.errorText)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MapleTokens.errorText.opacity(0.1))
            .accessibilityIdentifier("batch-rename-unsupported-banner")
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(vm.applyResults == nil ? "Cancel" : "Done") { onDismiss() }
                .accessibilityIdentifier("batch-rename-cancel-button")
        }
        if vm.applyResults == nil {
            ToolbarItem(placement: .confirmationAction) {
                Button("Rename \(vm.assets.count) Photos") {
                    Task { await vm.apply() }
                }
                .disabled(!vm.canApply || vm.isApplying)
                .accessibilityIdentifier("batch-rename-apply-button")
            }
        }
    }

    // MARK: - Helpers

    private var navigationTitle: String {
        if vm.applyResults != nil { return "Rename Results" }
        return "Batch Rename \(vm.assets.count) Photos"
    }
}

// MARK: - Preview

#Preview {
    BatchRenameSheet(
        vm: {
            let assets = (0..<3).map { i in
                AssetRef(url: URL(fileURLWithPath: "/tmp/test_\(i).dng"))
            }
            return BatchRenameViewModel(assets: assets, routing: .filesystem)
        }(),
        onDismiss: {}
    )
}
