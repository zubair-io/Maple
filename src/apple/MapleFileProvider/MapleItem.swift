// src/apple/MapleFileProvider/MapleItem.swift
import FileProvider
import MapleCore
import UniformTypeIdentifiers

final class MapleItem: NSObject, NSFileProviderItem {
    private let identifier: FileProviderIdentifier
    private let displayName: String
    private let isDirectory: Bool
    private let size: NSNumber?
    private let modified: Date?
    private let utType: UTType

    let itemIdentifier: NSFileProviderItemIdentifier
    let parentItemIdentifier: NSFileProviderItemIdentifier
    let filename: String
    var contentType: UTType { utType }
    var capabilities: NSFileProviderItemCapabilities { [.allowsReading] }   // read-only in Phase 1
    var documentSize: NSNumber? { size }
    var contentModificationDate: Date? { modified }
    var creationDate: Date? { modified }
    var itemVersion: NSFileProviderItemVersion {
        let mtimeBytes = String(Int(modified?.timeIntervalSince1970 ?? 0)).data(using: .utf8) ?? Data()
        return .init(contentVersion: mtimeBytes, metadataVersion: mtimeBytes)
    }
    var isUploaded: Bool { true }
    var isDownloaded: Bool { false }  // bytes fetched on demand

    init(libraryRoot root: LibraryRoot) {
        self.identifier = .folder(folderID: root.id, relativePath: "")
        self.displayName = root.label
        self.isDirectory = true
        self.size = nil
        self.modified = nil
        self.utType = .folder
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = .rootContainer
        self.filename = root.label
    }

    init(subdirectory dir: DirChild, parentFolderID: String, parentRelativePath: String, parentIdentifier: NSFileProviderItemIdentifier) {
        let child = parentRelativePath.isEmpty ? dir.name : "\(parentRelativePath)/\(dir.name)"
        self.identifier = .folder(folderID: parentFolderID, relativePath: child)
        self.displayName = dir.name
        self.isDirectory = true
        self.size = nil
        self.modified = dir.mtime
        self.utType = .folder
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = dir.name
    }

    /// Returns nil for unindexed images (no asset ID) — those cannot be fetched,
    /// so the enumerator drops them via `compactMap`.
    init?(image: ImageChild, parentIdentifier: NSFileProviderItemIdentifier) {
        guard let assetID = image.assetID, !assetID.isEmpty else { return nil }
        self.identifier = .asset(assetID)
        self.displayName = image.name
        self.isDirectory = false
        self.size = NSNumber(value: image.size)
        self.modified = image.mtime
        self.utType = UTType(filenameExtension: image.ext) ?? .data
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = image.name
    }
}
