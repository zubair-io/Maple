// AssetDropSheets.swift — the collision ask-flow sheet + end-of-batch
// report sheet, as ONE reusable `View` extension (#2646 review
// follow-up).
//
// `AppShell` presents these from two separate modifier chains (the
// Mac/iPad pane shell and the iPhone tab shell each build their own
// `body`), and the original hand-duplicated `.sheet` blocks were exactly
// the shape of bug the review caught: the collision sheet's implicit
// dismissal (swipe on iPadOS, Escape on macOS) never resumed
// `AssetDropCollisionResolver`'s continuation, permanently hanging
// `assetDropTask` — and a duplicated fix is a fix that can half-apply.
// Funneling both call sites through this single modifier means there is
// exactly one place the dismiss-resolves-to-skip logic can live, so it
// cannot drift out of sync between the two shells again.
import SwiftUI
import MapleCore

extension View {
    /// Attaches the collision-prompt sheet and the end-of-batch result
    /// sheet for the drag-onto-source-tree flow (#2646). `resolver` is a
    /// SEPARATE binding from `prompt` (rather than reaching into
    /// `prompt.wrappedValue?.resolver`) specifically so `onDismiss` can
    /// still reach it after SwiftUI has already nilled `prompt` as part of
    /// tearing the sheet down — which happens for BOTH a button tap (the
    /// content closure sets `prompt = nil` itself) and an implicit
    /// dismissal (SwiftUI sets it to nil directly). Either way,
    /// `AssetDropCollisionResolver.resolve` is safe to call unconditionally:
    /// it only resumes on the FIRST call, so `onDismiss` calling it after a
    /// button already resolved the same instance is a no-op, not a crash.
    func assetDropSheets(
        collisionPrompt: Binding<AssetDropCollisionPrompt?>,
        collisionResolver: Binding<AssetDropCollisionResolver?>,
        results: Binding<[AssetDropItemResult]?>
    ) -> some View {
        self
            .sheet(item: collisionPrompt, onDismiss: {
                // Implicit dismissal (swipe/Escape) — no button was
                // tapped. Resolve to Skip, matching what a Skip tap would
                // have done, then release the resolver reference.
                collisionResolver.wrappedValue?.resolve(.skip)
                collisionResolver.wrappedValue = nil
            }) { prompt in
                AssetDropCollisionSheet(displayName: prompt.displayName, onChoice: { choice in
                    prompt.resolver.resolve(choice)
                    collisionPrompt.wrappedValue = nil
                })
            }
            .sheet(isPresented: Binding(
                get: { results.wrappedValue != nil },
                set: { if !$0 { results.wrappedValue = nil } }
            )) {
                AssetDropResultSheet(results: results.wrappedValue ?? [], onDismiss: { results.wrappedValue = nil })
            }
    }
}
