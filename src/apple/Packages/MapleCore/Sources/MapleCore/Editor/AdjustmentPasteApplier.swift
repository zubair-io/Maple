// AdjustmentPasteApplier.swift — writes copy/paste/sync-scoped adjustment
// groups to N assets' sidecars (#944).
//
// Structure mirrors `BatchMetadataViewModel.applyToAsset`'s live-session-
// first, sidecar-fallback pattern. Unlike metadata (which is fine going
// straight to disk since it doesn't affect the rendered pixels), adjustment
// fields DO drive the live canvas — so when a target has an open
// `EditSession` this mutates `session.model` directly, letting the
// session's own `didSet` do the debounced sidecar write AND trigger a
// re-render. Assets with no open session go through a standalone
// `XMPSidecarStore` round trip instead.
//
// Every asset's own `CullingState` and IPTC/EXIF metadata block is
// preserved untouched — only the `AdjustmentModel` fields named by the
// requested groups move. Never writes to a path other than each target's
// own sidecar.

import Foundation

@MainActor
public enum AdjustmentPasteApplier {
    /// Resolve the current `AdjustmentModel` for `asset`: the live
    /// `EditSession`'s in-memory model when one is open, else whatever is
    /// on disk (or `.default` when no sidecar exists yet, or the read
    /// fails). Used to source "sync settings" from the focused image
    /// without requiring a prior copy step.
    public static func resolveModel(
        for asset: AssetRef,
        sessions: [AssetRef.ID: EditSession]
    ) async -> AdjustmentModel {
        if let session = sessions[asset.id] {
            return session.model
        }
        guard let url = asset.primaryURL else { return .default }
        let store = XMPSidecarStore(rawURL: url)
        let existing = try? await store.loadIfPresent()
        return existing?.0 ?? .default
    }

    /// Applies `source`, limited to `groups`, onto every asset in
    /// `targets`. Video assets (no `AdjustmentModel` — see
    /// `SidecarPath.isVideo`) and bytes-only assets with no `primaryURL`
    /// (no sidecar path to write) are skipped. Returns how many assets were
    /// actually written.
    @discardableResult
    public static func apply(
        source: AdjustmentModel,
        groups: Set<AdjustmentGroup>,
        to targets: [AssetRef],
        sessions: [AssetRef.ID: EditSession]
    ) async -> Int {
        var written = 0
        for asset in targets {
            guard let url = asset.primaryURL, !SidecarPath.isVideo(url) else { continue }

            if let session = sessions[asset.id] {
                session.model = AdjustmentGroupMerge.merged(
                    session.model, applying: source, groups: groups
                )
                written += 1
                continue
            }

            let store = XMPSidecarStore(rawURL: url)
            // `loadIfPresent()` distinguishes "no sidecar yet" (nil — start
            // from defaults, nothing to lose) from "sidecar present but
            // unreadable" (throws). A bulk paste must SKIP the unreadable
            // case rather than rebase onto defaults: rewriting from
            // `.default` would silently drop that image's stars, flag,
            // keywords, and every adjustment outside the pasted groups.
            let base: (model: AdjustmentModel, culling: CullingState)
            do {
                base = try await store.loadIfPresent() ?? (.default, CullingState())
            } catch {
                continue
            }
            let (model, culling) = base
            let mergedModel = AdjustmentGroupMerge.merged(model, applying: source, groups: groups)
            await store.update(model: mergedModel, culling: culling)
            await store.flush()
            written += 1
        }
        return written
    }
}
