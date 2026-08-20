// src/apple/Packages/MapleCore/Tests/MapleCoreTests/Helpers/FakeFileProviderItem.swift
import FileProvider
import Foundation
import UniformTypeIdentifiers

/// Minimal `NSFileProviderItem` test double for driving
/// `FileProviderExtensionCore`'s CRUD entry points directly (#2552).
///
/// The real conforming type in production, `MapleItem`, always derives
/// its fields from server-fetched metadata — there's no way to hand it
/// an arbitrary `itemVersion`/`filename`/`parentItemIdentifier` combo a
/// test needs to control. This type is a plain, settable stand-in.
///
/// `itemVersion.contentVersion` is encoded exactly the way
/// `MapleItem.itemVersion` encodes it — `"<epoch>-<identifier>"` when
/// `versionMtime` is set, `"v1-<identifier>"` otherwise — because
/// `FileProviderExtensionCore.modifyItem` decodes that prefix via
/// `MapleItem.decodePriorMtime` to recover the XMP write precondition.
final class FakeFileProviderItem: NSObject, NSFileProviderItem {
    var itemIdentifier: NSFileProviderItemIdentifier
    var parentItemIdentifier: NSFileProviderItemIdentifier
    var filename: String
    var contentType: UTType
    var contentModificationDate: Date?
    var capabilities: NSFileProviderItemCapabilities

    /// Feeds `itemVersion.contentVersion`'s epoch prefix — this is what
    /// `modifyItem` reads back as `priorMtime` for the sidecar
    /// precondition. `nil` produces the version-less `"v1-…"` seed.
    var versionMtime: Date?

    init(itemIdentifier: NSFileProviderItemIdentifier,
         parentItemIdentifier: NSFileProviderItemIdentifier,
         filename: String,
         contentType: UTType = .item,
         contentModificationDate: Date? = nil,
         versionMtime: Date? = nil,
         capabilities: NSFileProviderItemCapabilities = [.allowsReading, .allowsWriting]) {
        self.itemIdentifier = itemIdentifier
        self.parentItemIdentifier = parentItemIdentifier
        self.filename = filename
        self.contentType = contentType
        self.contentModificationDate = contentModificationDate
        self.versionMtime = versionMtime
        self.capabilities = capabilities
    }

    var itemVersion: NSFileProviderItemVersion {
        let seed: String
        if let versionMtime {
            seed = "\(Int(versionMtime.timeIntervalSince1970))-\(itemIdentifier.rawValue)"
        } else {
            seed = "v1-\(itemIdentifier.rawValue)"
        }
        let bytes = Data(seed.utf8)
        return .init(contentVersion: bytes, metadataVersion: bytes)
    }
}
