// MapleCloudKit re-export.
//
// The Cloud/Auth networking layer was extracted to the MapleCloudKit target
// (2026-07-18, Maple TV milestone A) so the tvOS app can link it without
// RawPipeline. Existing code — the app, extensions, and tests — keeps writing
// `import MapleCore` and sees the moved types through this re-export.
@_exported import MapleCloudKit
