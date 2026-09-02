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
    let onRestore: (TrashBrowserRow) async -> TrashRowActionOutcome
    let onPermanentlyDelete: (TrashBrowserRow) async -> TrashRowActionOutcome
    let onDismiss: () -> Void
    /// Folder-level restore (#2751) — Cloud only. `nil` suppresses the
    /// per-folder "Restore Folder" button entirely, so Local/SMB contexts
    /// (which have no server-side batch-restore-by-folder route) render
    /// exactly as before this ticket.
    var onRestoreFolder: ((String) async -> TrashRowActionOutcome)? = nil

    @State private var rows: [TrashBrowserRow] = []
    @State private var isLoading = true
    @State private var busyID: String?
    @State private var busyFolderID: String?
    @State private var errorMessage: String?
    @State private var pendingPermanentDelete: TrashBrowserRow?

    private static let dateStyle: Date.FormatStyle = .init(date: .abbreviated, time: .omitted)

    /// Rows grouped by the directory portion of `originalRelativePath`
    /// (#2751) — what turns the flat trashed-asset list into the
    /// "browsable/actionable folder surface" the ticket asks for, with no
    /// new server endpoint needed: every row already carries its own
    /// original location. `id == ""` is the root group — items trashed
    /// directly at the library root, which render as plain unheadered rows
    /// exactly like before this ticket (there's no root "folder" to
    /// restore as a unit). Root sorts first, subfolders alphabetically
    /// after it.
    private struct RowGroup: Identifiable {
        let id: String
        let folderName: String?
        let rows: [TrashBrowserRow]
    }

    private var groups: [RowGroup] {
        let grouped = Dictionary(grouping: rows) { row in
            (row.originalRelativePath as NSString).deletingLastPathComponent
        }
        let sortedKeys = grouped.keys.sorted { lhs, rhs in
            if lhs.isEmpty != rhs.isEmpty { return lhs.isEmpty }
            return lhs.localizedStandardCompare(rhs) == .orderedAscending
        }
        return sortedKeys.map { key in
            RowGroup(
                id: key,
                folderName: key.isEmpty ? nil : (key as NSString).lastPathComponent,
                rows: grouped[key] ?? []
            )
        }
    }

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
        // `presenting:` (review finding, jules): SwiftUI runs the dialog's
        // dismissal — which flips `isPresented` false and, via our
        // `Binding`'s setter, nils `pendingPermanentDelete` — BEFORE the
        // tapped button's own action closure executes. A closure that read
        // `pendingPermanentDelete` at action time (the prior shape) always
        // saw it already `nil` and silently no-opped instead of deleting.
        // `presenting:` hands the row to the actions closure AS A
        // PARAMETER, captured at dialog-presentation time, so the action
        // no longer depends on state that dismissal has already cleared.
        .confirmationDialog(
            "Delete Permanently",
            isPresented: Binding(
                get: { pendingPermanentDelete != nil },
                set: { if !$0 { pendingPermanentDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingPermanentDelete
        ) { row in
            Button("Delete Permanently", role: .destructive) {
                Task { await permanentlyDelete(row) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
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
            List {
                ForEach(groups) { group in
                    if let folderName = group.folderName {
                        Section {
                            ForEach(group.rows) { row in rowView(row) }
                        } header: {
                            folderHeader(folderName, group: group)
                        }
                    } else {
                        ForEach(group.rows) { row in rowView(row) }
                    }
                }
            }
            .listStyle(.plain)
        }
    }

    @ViewBuilder
    private func rowView(_ row: TrashBrowserRow) -> some View {
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
                .accessibilityLabel("Delete Permanently")
            }
        }
        .accessibilityIdentifier("trashBrowser.row.\(row.displayName)")
    }

    /// Section header for a non-root folder group (#2751) — the folder
    /// name plus, when `onRestoreFolder` is wired (Cloud only), a "Restore
    /// Folder" button that restores every row in `group` as one batch.
    @ViewBuilder
    private func folderHeader(_ folderName: String, group: RowGroup) -> some View {
        HStack {
            Text(folderName)
                .font(MapleTokens.Typography.eyebrow)
                .foregroundStyle(MapleTokens.textMuted)
            Spacer()
            if onRestoreFolder != nil {
                if busyFolderID == group.id {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Restore Folder") { Task { await restoreFolder(group) } }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityIdentifier("trashBrowser.restoreFolder.\(group.id)")
                }
            }
        }
    }

    private func reload() async {
        isLoading = true
        rows = await onLoad()
        isLoading = false
    }

    private func restore(_ row: TrashBrowserRow) async {
        busyID = row.id
        let outcome = await onRestore(row)
        busyID = nil
        apply(outcome, to: row, failureFallback: "Couldn't restore \"\(row.displayName)\" — the original location may no longer be reachable.")
    }

    private func permanentlyDelete(_ row: TrashBrowserRow) async {
        busyID = row.id
        let outcome = await onPermanentlyDelete(row)
        busyID = nil
        apply(outcome, to: row, failureFallback: "Couldn't permanently delete \"\(row.displayName)\".")
    }

    /// Restore every row in `group` as one batch (#2751). `onRestoreFolder`
    /// is only ever non-nil for the Cloud context, which is what makes this
    /// reachable at all — the button that calls it only renders then.
    ///
    /// Reloads from `onLoad()` on every outcome rather than removing rows
    /// client-side: `restoreTrashBrowserFolder` reports a folder restore
    /// that partly succeeded as `.failed("N of M items ... could not be
    /// restored")`, which means SOME of this group's assets already left
    /// the server's trash even though the overall call "failed" — the only
    /// way to know exactly which rows survived is to ask the server again,
    /// same as a fresh `onLoad()` would.
    private func restoreFolder(_ group: RowGroup) async {
        guard let onRestoreFolder else { return }
        busyFolderID = group.id
        let outcome = await onRestoreFolder(group.id)
        busyFolderID = nil
        switch outcome {
        case .succeeded:
            errorMessage = nil
        case .stale(let reason):
            errorMessage = reason
        case .failed(let message):
            errorMessage = message.isEmpty ? "Couldn't restore \"\(group.folderName ?? "folder")\"." : message
        }
        await reload()
    }

    /// Shared outcome handling for both single-row actions. `.stale` (a
    /// Cloud `?intent=` 409 — the server refused because the asset's
    /// actual state no longer matches this row, e.g. it was restored
    /// elsewhere) removes the row exactly like a success, since it no
    /// longer belongs in this trash list, but still surfaces WHY via
    /// `errorMessage` so the removal isn't unexplained.
    private func apply(_ outcome: TrashRowActionOutcome, to row: TrashBrowserRow, failureFallback: String) {
        switch outcome {
        case .succeeded:
            rows.removeAll { $0.id == row.id }
            errorMessage = nil
        case .stale(let reason):
            rows.removeAll { $0.id == row.id }
            errorMessage = reason
        case .failed(let message):
            errorMessage = message.isEmpty ? failureFallback : message
        }
    }

}

// MARK: - Previews

#Preview("SMB — no folder grouping affordance") {
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
        onRestore: { _ in .succeeded },
        onPermanentlyDelete: { _ in .succeeded },
        onDismiss: {}
    )
}

/// #2751 — Cloud grouping: two items under `2024/Paris` (with a "Restore
/// Folder" button on that group's header), one at the library root
/// (no header, no folder-restore affordance — see `RowGroup`'s doc
/// comment on why the root group never gets one).
#Preview("Cloud — grouped with Restore Folder") {
    TrashBrowserSheet(
        context: .cloud(server: URL(string: "https://preview.maple.invalid")!, libraryFolderID: "lib-1", displayName: "preview.maple"),
        onLoad: {
            [
                TrashBrowserRow(cloud: TrashItem(
                    assetID: "a1", filename: "IMG_1.dng", originalRelativePath: "2024/Paris/IMG_1.dng",
                    trashRelativePath: ".maple/trash/2024/Paris/IMG_1.dng", size: 1024,
                    mtime: Date(), deletedAt: Date()
                )),
                TrashBrowserRow(cloud: TrashItem(
                    assetID: "a2", filename: "IMG_2.dng", originalRelativePath: "2024/Paris/IMG_2.dng",
                    trashRelativePath: ".maple/trash/2024/Paris/IMG_2.dng", size: 2048,
                    mtime: Date(), deletedAt: Date()
                )),
                TrashBrowserRow(cloud: TrashItem(
                    assetID: "a3", filename: "IMG_3.dng", originalRelativePath: "IMG_3.dng",
                    trashRelativePath: ".maple/trash/IMG_3.dng", size: 512,
                    mtime: Date(), deletedAt: Date()
                )),
            ].compactMap { $0 }
        },
        onRestore: { _ in .succeeded },
        onPermanentlyDelete: { _ in .succeeded },
        onDismiss: {},
        onRestoreFolder: { _ in .succeeded }
    )
}
