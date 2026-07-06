// LibraryDestination.swift — typed navigation route for the iPhone Library
// tab's NavigationStack (Fast Preview epic §1).
//
// Before: the Library tab's `NavigationStack(path:)` held `[AssetRef]` and a
// single `.navigationDestination(for: AssetRef.self)` that resolved every push
// straight into the editor. The Fast Preview design inserts a Preview surface
// in front of the editor, so a grid tap must push PREVIEW and Preview's Edit
// button must push the EDITOR — two distinct destinations on one linear stack.
//
// A single `AssetRef`-typed path can't distinguish the two, so the path becomes
// `[LibraryDestination]`: `grid tap → .preview(asset)`, `Edit → .edit(asset)`.
// Back pops one level (`editor → preview → grid`), matching the spec's back
// stack exactly, and the stack stays deep-linkable.

#if os(iOS)

import MapleCore

/// One entry on the iPhone Library tab's navigation stack.
///
/// `Hashable` (required for `NavigationStack` path values) rides on `AssetRef`'s
/// own `Hashable` conformance plus the case discriminant, so `.preview(a)` and
/// `.edit(a)` for the same asset are distinct stack entries.
enum LibraryDestination: Hashable {
    /// The fast static Preview surface (default target of a grid / filmstrip /
    /// cloud-result tap).
    case preview(AssetRef)
    /// The live editor for the asset (reached only from Preview's Edit button).
    case edit(AssetRef)

    /// The asset this destination is about — convenient for the resolver.
    var asset: AssetRef {
        switch self {
        case .preview(let a), .edit(let a): return a
        }
    }
}

#endif
