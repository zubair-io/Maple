// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift
import Foundation

public enum FileProviderIdentifier: Equatable, Hashable, Sendable {
    case asset(String)
    case folder(folderID: String, relativePath: String)
    /// A regular file that is NOT an indexed image — e.g. a PDF, a `.mov`,
    /// or an extensionless file. Stored + synced but has no `AssetDoc`, so
    /// it's addressed by `(folderID, relativePath)` rather than an asset id.
    /// `relativePath` is the file relative to its library root.
    case file(folderID: String, relativePath: String)
    /// XMP sidecar paired to an asset. `conflictBasename` is nil for the
    /// canonical `<base>.xmp` and non-nil for conflict copies
    /// (`<base> (conflict from <device>).xmp`). The basename excludes the
    /// `.xmp` extension.
    case sidecar(assetID: String, conflictBasename: String?)
    /// Per-library Trash virtual container. Children = trashed asset items.
    case trash(folderID: String)
    /// Synthetic `.maple/` container surfaced under every enumerable
    /// folder. The server filters `.maple/` out of `/api/fs/dir` (dotdir
    /// hide), so the FP extension synthesizes the dir client-side from
    /// the parent folder's image list. `parentRelativePath` is the
    /// enclosing folder relative to its library root (`""` at the
    /// library root). Contains a single synthesized `thumbs/` child.
    case mapleDir(folderID: String, parentRelativePath: String)
    /// Synthetic `.maple/thumbs/` container. Children are one
    /// `.thumb(assetID:)` per indexed image in `parentRelativePath`,
    /// named after the server's on-disk filename convention
    /// (`<sha256_prefix16(image basename)>.avif`).
    case mapleThumbsDir(folderID: String, parentRelativePath: String)
    /// Pre-rendered AVIF thumbnail for an asset, served from the
    /// server-side `.maple/thumbs/` cache via
    /// `GET /api/assets/<id>/thumb`. Surfaces under
    /// `.mapleThumbsDir(folderID:parentRelativePath:)`.
    case thumb(assetID: String)

    public enum DecodeError: Error {
        case invalidPrefix, malformedFolder, malformedFile, malformedSidecar, malformedTrash,
             malformedMapleDir, malformedThumbsDir, malformedThumb, badBase64
    }

    public var rawValue: String {
        switch self {
        case .asset(let id):
            return "asset/\(id)"
        case .folder(let folderID, let relativePath):
            return "folder/\(folderID):\(Self.b64urlEncode(relativePath))"
        case .file(let folderID, let relativePath):
            return "file/\(folderID):\(Self.b64urlEncode(relativePath))"
        case .sidecar(let assetID, let conflictBasename):
            if let conflictBasename {
                return "sidecar/\(assetID):\(Self.b64urlEncode(conflictBasename))"
            }
            return "sidecar/\(assetID)"
        case .trash(let folderID):
            return "trash/\(folderID)"
        case .mapleDir(let folderID, let parentRelativePath):
            return "mapledir/\(folderID):\(Self.b64urlEncode(parentRelativePath))"
        case .mapleThumbsDir(let folderID, let parentRelativePath):
            return "mapledirthumbs/\(folderID):\(Self.b64urlEncode(parentRelativePath))"
        case .thumb(let assetID):
            return "thumb/\(assetID)"
        }
    }

    public init(rawValue: String) throws {
        if let id = rawValue.dropPrefixIfPresent("asset/") {
            self = .asset(String(id))
            return
        }
        if let body = rawValue.dropPrefixIfPresent("folder/") {
            guard let colon = body.firstIndex(of: ":") else { throw DecodeError.malformedFolder }
            let folderID = String(body[..<colon])
            let encoded = String(body[body.index(after: colon)...])
            guard let path = Self.b64urlDecode(encoded) else { throw DecodeError.badBase64 }
            self = .folder(folderID: folderID, relativePath: path)
            return
        }
        if let body = rawValue.dropPrefixIfPresent("file/") {
            guard let colon = body.firstIndex(of: ":") else { throw DecodeError.malformedFile }
            let folderID = String(body[..<colon])
            if folderID.isEmpty { throw DecodeError.malformedFile }
            let encoded = String(body[body.index(after: colon)...])
            guard let path = Self.b64urlDecode(encoded) else { throw DecodeError.badBase64 }
            // An empty relativePath isn't a meaningful leaf — and the server's
            // `?path=` rejects it — so reject it here rather than minting an
            // unusable `.file(..., relativePath: "")`.
            if path.isEmpty { throw DecodeError.malformedFile }
            self = .file(folderID: folderID, relativePath: path)
            return
        }
        if let body = rawValue.dropPrefixIfPresent("sidecar/") {
            if let colon = body.firstIndex(of: ":") {
                let assetID = String(body[..<colon])
                if assetID.isEmpty { throw DecodeError.malformedSidecar }
                let encoded = String(body[body.index(after: colon)...])
                if encoded.isEmpty {
                    self = .sidecar(assetID: assetID, conflictBasename: nil)
                    return
                }
                guard let name = Self.b64urlDecode(encoded) else { throw DecodeError.badBase64 }
                self = .sidecar(assetID: assetID, conflictBasename: name)
                return
            }
            let assetID = String(body)
            if assetID.isEmpty { throw DecodeError.malformedSidecar }
            self = .sidecar(assetID: assetID, conflictBasename: nil)
            return
        }
        if let body = rawValue.dropPrefixIfPresent("trash/") {
            let folderID = String(body)
            if folderID.isEmpty { throw DecodeError.malformedTrash }
            self = .trash(folderID: folderID)
            return
        }
        // The `mapledirthumbs/` check MUST precede `mapledir/` — both
        // share the `mapledir` prefix, and `dropPrefixIfPresent` accepts
        // the first match. Reversing the order would misroute every
        // thumbs container to `.mapleDir` and break enumeration.
        if let body = rawValue.dropPrefixIfPresent("mapledirthumbs/") {
            guard let colon = body.firstIndex(of: ":") else {
                throw DecodeError.malformedThumbsDir
            }
            let folderID = String(body[..<colon])
            if folderID.isEmpty { throw DecodeError.malformedThumbsDir }
            let encoded = String(body[body.index(after: colon)...])
            guard let path = Self.b64urlDecode(encoded) else {
                throw DecodeError.badBase64
            }
            self = .mapleThumbsDir(folderID: folderID, parentRelativePath: path)
            return
        }
        if let body = rawValue.dropPrefixIfPresent("mapledir/") {
            guard let colon = body.firstIndex(of: ":") else {
                throw DecodeError.malformedMapleDir
            }
            let folderID = String(body[..<colon])
            if folderID.isEmpty { throw DecodeError.malformedMapleDir }
            let encoded = String(body[body.index(after: colon)...])
            guard let path = Self.b64urlDecode(encoded) else {
                throw DecodeError.badBase64
            }
            self = .mapleDir(folderID: folderID, parentRelativePath: path)
            return
        }
        if let body = rawValue.dropPrefixIfPresent("thumb/") {
            let assetID = String(body)
            if assetID.isEmpty { throw DecodeError.malformedThumb }
            self = .thumb(assetID: assetID)
            return
        }
        throw DecodeError.invalidPrefix
    }

    private static func b64urlEncode(_ s: String) -> String {
        let data = Data(s.utf8)
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func b64urlDecode(_ s: String) -> String? {
        if s.isEmpty { return "" }
        var padded = s.replacingOccurrences(of: "-", with: "+")
                      .replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded.append("=") }
        guard let data = Data(base64Encoded: padded),
              let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }
}

private extension String {
    func dropPrefixIfPresent(_ prefix: String) -> Substring? {
        guard hasPrefix(prefix) else { return nil }
        return dropFirst(prefix.count)
    }
}
