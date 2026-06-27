// XmpMetadata+Empty.swift — "no fields set" check for the IPTC/EXIF metadata
// block, used by XMPSidecarStore to decide whether a write needs a metadata
// block at all (an all-nil block must serialize identically to no block).
//
// Ticket #1629 / epic #1575.

import Foundation

extension XmpMetadata {
    /// True when every field is nil, i.e. there is no metadata to serialize.
    public var isEmpty: Bool {
        gpsLatitude == nil && gpsLongitude == nil && gpsAltitude == nil
            && dateTimeOriginal == nil && timeZone == nil
            && sublocation == nil && city == nil && state == nil
            && country == nil && countryCode == nil
            && title == nil && caption == nil && headline == nil && instructions == nil
            && creator == nil && creatorJobTitle == nil && copyrightNotice == nil
            && copyrightStatus == nil && usageTerms == nil && credit == nil && source == nil
    }
}
