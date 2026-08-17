// BatchRenameViewModel+CaptureDates.swift — the EXIF capture-date cache
// consumed by `{date:FORMAT}` in the Batch Rename sheet (#2641).
//
// Split out of BatchRenameViewModel.swift as a self-contained concern (see
// that file's header): resolving `ImageMetadataReader
// .readRawCaptureDateStrings` synchronously, on the main actor, for every
// asset on every debounced keystroke was a real UI-hang hazard on a large
// selection — and it paid that cost even when the template had no
// `{date:...}` token to justify it. This file fixes both halves:
//
//   1. Off the main actor, resolved ONCE. `ensureCapturedAtCacheIfNeeded`
//      runs every asset's read inside a `TaskGroup`, driven by the
//      injectable `captureDateReader` closure, and caches the result per
//      asset id in `capturedAtCache`. `assets` is a fixed snapshot for the
//      view model's whole lifetime, so this one pass — triggered by
//      whichever `refreshPreview()` call first sees a template that needs
//      it — permanently covers every asset; a later refresh (even with a
//      different date-using template) reuses the cache instead of
//      re-reading.
//   2. Skipped entirely when unnecessary. `templateNeedsCapturedAt` is a
//      plain substring check against the engine's own token grammar; a
//      template with no `{date:` token (`{original}`, `{n}`-only, literal
//      text — most templates) never touches disk at all.
//
// `refreshPreview()` (BatchRenameViewModel.swift) `await`s
// `ensureCapturedAtCacheIfNeeded` to completion BEFORE calling
// `renderLocalPreview` below, so the preview is never computed against a
// half-resolved cache — there is no window where some assets show a
// resolved date and others show the engine's fallback text within one
// render.

import Foundation

extension BatchRenameViewModel {

    /// `true` iff `template` contains a `{date:` token — a plain substring
    /// check against the engine's own token grammar
    /// (`raw_core::filename::parse_template`: a token body must literally
    /// start with `"date:"`). A false positive (the substring appears
    /// outside a real token) only costs a needless cache pass, never
    /// correctness; there is no false negative, since any real date token
    /// must contain this exact substring.
    static func templateNeedsCapturedAt(_ template: String) -> Bool {
        template.contains("{date:")
    }

    /// Resolve every asset's EXIF capture date OFF THE MAIN ACTOR, exactly
    /// once for this view model's lifetime, and only when the template
    /// actually needs `{date:...}` — see the file header for the full
    /// reasoning.
    func ensureCapturedAtCacheIfNeeded(for template: String) async {
        guard Self.templateNeedsCapturedAt(template), !capturedAtCachePopulated else { return }
        capturedAtCachePopulated = true
        let reader = captureDateReader
        let targets = assets
        let resolved: [(AssetRef.ID, String?)] = await withTaskGroup(
            of: (AssetRef.ID, String?).self
        ) { group in
            for asset in targets {
                group.addTask {
                    guard let url = asset.primaryURL else { return (asset.id, nil) }
                    return (asset.id, reader(url))
                }
            }
            var results: [(AssetRef.ID, String?)] = []
            results.reserveCapacity(targets.count)
            for await result in group { results.append(result) }
            return results
        }
        for (id, value) in resolved {
            capturedAtCache[id] = value
        }
    }

    /// Filesystem/SMB preview — the same template engine apply() uses,
    /// applied in ORDER so a self-colliding template is flagged
    /// (`duplicate`) exactly like the API preview does for Cloud. No
    /// filesystem writes; `SidecarPath`/`FileManager` are never touched
    /// here. Reads captured-at from the ALREADY-POPULATED `capturedAtCache`
    /// (a plain dictionary lookup) rather than hitting disk itself — see
    /// `ensureCapturedAtCacheIfNeeded` above.
    static func renderLocalPreview(
        assets: [AssetRef], template: String, sequenceStart: Int, sequencePadWidth: Int,
        capturedAtCache: [AssetRef.ID: String?]
    ) -> [BatchRenamePreviewItem] {
        var seen = Set<String>()
        var items: [BatchRenamePreviewItem] = []
        items.reserveCapacity(assets.count)
        for (index, asset) in assets.enumerated() {
            let full = asset.fullFilename
            let (stem, ext) = splitStemExt(full)
            do {
                let rendered = try FilenameTemplateEngine.render(
                    template: template, originalStem: stem, ext: ext,
                    capturedAtExifString: capturedAtCache[asset.id] ?? nil,
                    sequenceStart: sequenceStart, sequenceIndex: UInt64(index),
                    sequencePadWidth: sequencePadWidth)
                let duplicate = seen.contains(rendered)
                seen.insert(rendered)
                items.append(BatchRenamePreviewItem(
                    id: asset.id, oldFilename: full, newFilename: rendered, duplicate: duplicate))
            } catch {
                items.append(BatchRenamePreviewItem(
                    id: asset.id, oldFilename: full, error: error.localizedDescription))
            }
        }
        return items
    }
}
