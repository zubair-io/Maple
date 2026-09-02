// TrashSheets.swift — the end-of-batch trash report sheet + the in-app
// Trash browser sheet (#2653), as one reusable `View` extension. Mirrors
// `AssetDropSheets.swift`'s shape: `AppShell` presents these from two
// separate `body` chains (Mac/iPad pane shell, iPhone tab shell), so
// funneling both through one modifier keeps them from drifting apart the
// way the collision-sheet fix `AssetDropSheets.swift` documents.

import SwiftUI
import MapleCore

extension View {
    func assetTrashSheets(
        results: Binding<[AssetTrashItemResult]?>,
        trashBrowserContext: Binding<TrashBrowserContext?>,
        onLoad: @escaping () async -> [TrashBrowserRow],
        onRestore: @escaping (TrashBrowserRow) async -> TrashRowActionOutcome,
        onPermanentlyDelete: @escaping (TrashBrowserRow) async -> TrashRowActionOutcome,
        onDismissBrowser: @escaping () -> Void,
        /// Folder-level restore (#2751) — Cloud only. `nil` suppresses the
        /// browser's "Restore Folder" affordance for non-Cloud contexts.
        onRestoreFolder: ((String) async -> TrashRowActionOutcome)? = nil
    ) -> some View {
        self
            .sheet(isPresented: Binding(
                get: { results.wrappedValue != nil },
                set: { if !$0 { results.wrappedValue = nil } }
            )) {
                AssetTrashResultSheet(results: results.wrappedValue ?? [], onDismiss: { results.wrappedValue = nil })
            }
            .sheet(item: trashBrowserContext, onDismiss: onDismissBrowser) { context in
                TrashBrowserSheet(
                    context: context,
                    onLoad: onLoad,
                    onRestore: onRestore,
                    onPermanentlyDelete: onPermanentlyDelete,
                    onDismiss: { trashBrowserContext.wrappedValue = nil },
                    onRestoreFolder: onRestoreFolder
                )
            }
    }
}
