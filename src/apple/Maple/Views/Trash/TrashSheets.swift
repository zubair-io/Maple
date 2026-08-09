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
        onRestore: @escaping (TrashBrowserRow) async -> Bool,
        onPermanentlyDelete: @escaping (TrashBrowserRow) async -> Bool,
        onDismissBrowser: @escaping () -> Void
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
                    onDismiss: { trashBrowserContext.wrappedValue = nil }
                )
            }
    }
}
