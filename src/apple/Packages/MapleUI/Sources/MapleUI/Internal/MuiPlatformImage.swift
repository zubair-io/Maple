// MuiPlatformImage.swift — cross-platform local-file image decode, shared
// by MuiImage and MuiAvatar. Both atoms need the exact same thing: turn a
// local/blob file URL into a SwiftUI `Image` off the main thread, and fail
// gracefully (nil) rather than throwing, so each caller's own broken/error
// presentation decides what happens next. Factored out once a second real
// caller (Avatar) needed it — not built ahead of need.

import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

enum MuiPlatformImage {
    /// Decodes `url`'s bytes into a SwiftUI `Image`, off the caller's actor
    /// but still inside the caller's own structured task — this is a plain
    /// `nonisolated` async function, not a `Task.detached` spawn, so a
    /// MainActor caller (e.g. a SwiftUI `.task(id:)`) hops to the
    /// cooperative background pool for the call and hops back on return,
    /// with no separate unstructured task in between. That matters for
    /// cancellation: `Task.detached` creates an independent task tree, so
    /// cancelling the caller (a rapid URL change re-triggering `.task(id:)`)
    /// never reached the detached decode and left it running. Calling
    /// straight into this function is a suspension point of the *same*
    /// task, so the caller's cancellation is visible here via
    /// `Task.checkCancellation()`.
    /// Returns `nil` on any read/decode failure or on cancellation — never
    /// throws, since every caller here already has its own "broken" visual
    /// state to fall into.
    static func load(from url: URL) async -> Image? {
        do {
            try Task.checkCancellation()
            guard let data = try? Data(contentsOf: url) else { return nil }
            try Task.checkCancellation()
            return decode(data)
        } catch {
            return nil
        }
    }

    /// Decodes already-fetched bytes (e.g. from a network response) into a
    /// SwiftUI `Image`. Shared by `MuiRemoteImage`'s default loader.
    static func decode(_ data: Data) -> Image? {
        #if canImport(UIKit)
        guard let uiImage = UIImage(data: data) else { return nil }
        return Image(uiImage: uiImage)
        #elseif canImport(AppKit)
        guard let nsImage = NSImage(data: data) else { return nil }
        return Image(nsImage: nsImage)
        #else
        return nil
        #endif
    }
}
