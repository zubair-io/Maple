// Sources/MapleBackup/PayloadAssembler.swift
//
// Pure-transform layer for building upload payloads. PhotoKit-touching code
// (the actual `PHAsset` → bytes + metadata read) lives in MapleApp's
// PhotoKitAssetReader (Phase 3 Task 3.2). This file has no PhotoKit imports
// so it's testable in `swift test`.
//
// Currently exposes `buildSidecarXMP(input:)` which produces the `.xmp`
// payload that lands alongside the asset bytes in the cloud library. The XMP
// is also stored in AppSupportSidecarStore for not-yet-uploaded edits
// (spec §11).
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §8.

import Foundation

public enum PayloadAssembler {

    public struct SidecarInput: Sendable {
        public let phassetLocalId: String
        /// `PHCloudIdentifier.stringValue` for the asset — stable across
        /// every device on the same iCloud Photos account. `nil` when the
        /// device doesn't have iCloud Photos enabled, or PhotoKit's
        /// `cloudIdentifierMappings(forLocalIdentifiers:)` lookup didn't
        /// resolve. Forwarded to the server as `X-Maple-PHAsset-Cloud-Id`
        /// so the cloud library can serve a cross-device-stable join key.
        public let phassetCloudId: String?
        public let deviceId: String
        public let captureDate: Date
        public let latitude: Double?
        public let longitude: Double?
        public let favorite: Bool
        public let caption: String?
        public let keywords: [String]
        public let tags: [String]
        public let livePhotoCompanion: String?
        public let burstStackId: String?
        public let originalFilename: String
        public let mtime: TimeInterval

        public init(phassetLocalId: String, deviceId: String, captureDate: Date,
                    latitude: Double?, longitude: Double?, favorite: Bool,
                    caption: String?, keywords: [String], tags: [String],
                    livePhotoCompanion: String?, burstStackId: String?,
                    originalFilename: String, mtime: TimeInterval,
                    phassetCloudId: String? = nil) {
            self.phassetLocalId = phassetLocalId
            self.phassetCloudId = phassetCloudId
            self.deviceId = deviceId
            self.captureDate = captureDate
            self.latitude = latitude
            self.longitude = longitude
            self.favorite = favorite
            self.caption = caption
            self.keywords = keywords
            self.tags = tags
            self.livePhotoCompanion = livePhotoCompanion
            self.burstStackId = burstStackId
            self.originalFilename = originalFilename
            self.mtime = mtime
        }
    }

    public static func buildSidecarXMP(input: SidecarInput) -> String {
        let iso = ISO8601DateFormatter().string(from: input.captureDate)
        let lat = input.latitude.map { String($0) } ?? ""
        let lon = input.longitude.map { String($0) } ?? ""
        let caption = xmlEscape(input.caption ?? "")
        let live = xmlEscape(input.livePhotoCompanion ?? "")
        let burst = xmlEscape(input.burstStackId ?? "")
        let filename = xmlEscape(input.originalFilename)
        let kw = input.keywords.map { "<rdf:li>\(xmlEscape($0))</rdf:li>" }.joined()
        let tags = input.tags.map { "<rdf:li>\(xmlEscape($0))</rdf:li>" }.joined()

        return """
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                   xmlns:maple="https://justmaple.app/ns/maple/1.0/">
            <rdf:Description
              maple:phassetLocalId="\(input.phassetLocalId)"
              maple:deviceId="\(input.deviceId)"
              maple:captureDate="\(iso)"
              maple:gpsLat="\(lat)"
              maple:gpsLon="\(lon)"
              maple:favorite="\(input.favorite ? "True" : "False")"
              maple:caption="\(caption)"
              maple:livePhotoCompanion="\(live)"
              maple:burstStackId="\(burst)"
              maple:originalFilename="\(filename)"
              maple:mtime="\(input.mtime)">
              <maple:keywords><rdf:Bag>\(kw)</rdf:Bag></maple:keywords>
              <maple:tags><rdf:Bag>\(tags)</rdf:Bag></maple:tags>
            </rdf:Description>
          </rdf:RDF>
        </x:xmpmeta>
        """
    }

    /// Minimal XML-attribute / element escaping. Order matters — `&` first,
    /// then the four chars that can break an attribute value or element body.
    private static func xmlEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
         .replacingOccurrences(of: "<", with: "&lt;")
         .replacingOccurrences(of: ">", with: "&gt;")
         .replacingOccurrences(of: "\"", with: "&quot;")
         .replacingOccurrences(of: "'", with: "&apos;")
    }
}
