// TrashBrowserSheet.swift — in-app Trash browsing/restore UI (#2653) for
// `.maple/trash`-backed sources (iOS/iPadOS Filesystem, SMB) and Cloud.
// macOS Filesystem never presents this — Finder's own Trash is the UI for
// it (see `AppShell+Trash.swift`'s file header).
//
// Business logic (listing, restore, permanent delete — each source-kind
// routed to its own MapleCore engine or `RemoteCatalog`) lives in
// `AppShell+Trash.swift`; this view is a thin list bound to closures, same
// separation as every other sheet in this app ("AppShell owns actions,
// views declarative").

import SwiftUI
import MapleCore

struct TrashBrowserSheet: View {
    let context: TrashBrowserContext
    let onLoad: () async -> [TrashBrowserRow]
    /// Returns `true` on success.
    let onRestore: (TrashBrowserRow) async -> Bool
    /// Returns `true` on success.
    let onPermanentlyDelete: (TrashBrowserRow) async -> Bool
    let onDismiss: () -> Void

    @State private var rows: [TrashBrowserRow] = []
    @State private var isLoading = true
    @State private var busyID: String?
    @State private var errorMessage: String?
    @State private var pendingPermanentDelete: TrashBrowserRow?

    private static let dateStyle: Date.FormatStyle = .init(date: .abbreviated, time: .omitted)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Trash — \(context.title)")
                    .font(MapleTokens.Typography.sheetTitle)
                    .foregroundStyle(MapleTokens.textMain)
                Text(subtitle)
                    .font(MapleTokens.Typography.body)
                    .foregroundStyle(MapleTokens.textMuted)
            }
            .padding(20)

            Divider()

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 11))
                    .foregroundStyle(MapleTokens.errorText)
                    .padding(10)
            }

            content

            Divider()

            HStack {
                Spacer()
                Button("Done", action: onDismiss)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("trashBrowser.done")
            }
            .padding(16)
        }
        .frame(minWidth: 460, minHeight: 380)
        .task { await reload() }
        .confirmationDialog(
            "Delete Permanently", isPresented: Binding(
                get: { pendingPermanentDelete != nil },
                set: { if !$0 { pendingPermanentDelete = nil } }
            ), titleVisibility: .visible
        ) {
            Button("Delete Permanently", role: .destructive) {
                guard let row = pendingPermanentDelete else { return }
                pendingPermanentDelete = nil
                Task { await permanentlyDelete(row) }
            }
            Button("Cancel", role: .cancel) { pendingPermanentDelete = nil }
        } message: {
            Text("This item will be permanently deleted and cannot be recovered.")
        }
    }

    private var subtitle: String {
        switch context {
        case .cloud:
            return "Restored items go back to their original folder on the server."
        default:
            return "Restored items go back to their original folder — 30-day auto-purge applies here (not to your OS Trash)."
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            VStack {
                Spacer()
                ProgressView()
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if rows.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "trash")
                    .font(.system(size: 36))
                    .foregroundStyle(MapleTokens.textMuted)
                Text("Trash is empty")
                    .font(MapleTokens.Typography.rowLabel)
                    .foregroundStyle(MapleTokens.textMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("trashBrowser.empty")
        } else {
            List(rows) { row in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.displayName)
                            .font(MapleTokens.Typography.rowLabel)
                            .foregroundStyle(MapleTokens.textMain)
                        if let date = row.trashedDate {
                            Text("Trashed \(date, format: Self.dateStyle)")
                                .font(MapleTokens.Typography.body)
                                .foregroundStyle(MapleTokens.textMuted)
                        }
                    }
                    Spacer()
                    if busyID == row.id {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("Restore") { Task { await restore(row) } }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("trashBrowser.restore.\(row.id)")
                        Button(role: .destructive) { pendingPermanentDelete = row } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("trashBrowser.deletePermanently.\(row.id)")
                    }
                }
                .accessibilityIdentifier("trashBrowser.row.\(row.displayName)")
            }
            .listStyle(.plain)
        }
    }

    private func reload() async {
        isLoading = true
        rows = await onLoad()
        isLoading = false
    }

    private func restore(_ row: TrashBrowserRow) async {
        busyID = row.id
        let ok = await onRestore(row)
        busyID = nil
        if ok {
            rows.removeAll { $0.id == row.id }
        } else {
            errorMessage = "Couldn't restore \"\(row.displayName)\" — the original location may no longer be reachable."
        }
    }

    private func permanentlyDelete(_ row: TrashBrowserRow) async {
        busyID = row.id
        let ok = await onPermanentlyDelete(row)
        busyID = nil
        if ok {
            rows.removeAll { $0.id == row.id }
        } else {
            errorMessage = "Couldn't permanently delete \"\(row.displayName)\"."
        }
    }
}

// MARK: - Previews

#Preview {
    TrashBrowserSheet(
        context: .smb(.init(host: "nas.local", share: "Photos", username: "user")),
        onLoad: {
            [
                TrashBrowserRow(local: TrashedItem(
                    id: "1", primaryPath: "/trash/IMG_1.dng", sidecarPath: nil,
                    originalRelativePath: "2024/Paris/IMG_1.dng", trashedDate: Date(), size: 1024
                )),
            ]
        },
        onRestore: { _ in true },
        onPermanentlyDelete: { _ in true },
        onDismiss: {}
    )
}
