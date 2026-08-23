// MuiPasteboard.swift — the platform-clipboard shim MuiCodeBlock copies
// through. Same idea as MuiPlatformImage's `#if canImport(UIKit)/AppKit`
// split, wrapped behind a protocol so `MuiCodeBlockController`'s tests can
// inject a fake and assert on the copied text without touching the real
// system pasteboard.

import Foundation

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

protocol MuiPasteboardWriting {
    func copy(_ text: String)
}

struct MuiSystemPasteboard: MuiPasteboardWriting {
    func copy(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}
