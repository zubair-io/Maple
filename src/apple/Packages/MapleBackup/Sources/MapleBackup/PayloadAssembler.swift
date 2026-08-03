// Sources/MapleBackup/PayloadAssembler.swift
//
// Pure-transform layer for building upload payloads. PhotoKit-touching code
// (the actual `PHAsset` → bytes + metadata read) lives in MapleApp's
// PhotoKitAssetReader (Phase 3 Task 3.2). This file has no PhotoKit imports
// so it's testable in `swift test`.
//
// `SidecarInput` carries the PHAsset-derived fields `BackupEngine` needs for
// the primary ingest request and companion headers (capture date, GPS,
// phassetCloudId, ...). It no longer builds a synthetic `.xmp` payload from
// this data (#2553) — a sidecar is only ever the user's real local Maple
// edit, read from AppSupportSidecarStore, never derived from bare PHAsset
// metadata.
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
}
