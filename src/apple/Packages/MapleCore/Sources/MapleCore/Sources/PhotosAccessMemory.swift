// PhotosAccessMemory.swift — remembers whether Photos access was ever
// granted, so the app can tell "never asked" apart from "had access and
// lost it" (#2851).
//
// The distinction matters because losing a grant is invisible to the app:
// a re-signed test build (macOS TCC keys on code signature), a device
// restore, or a privacy reset all put authorization back to
// `.notDetermined` while the app's own state (backup settings, saved
// source selection) persists. PhotoKit publishes no authorization-change
// notification, so the only durable signal is one we record ourselves.
//
// The memory is write-once in spirit: it latches true the first time a
// granted status is observed and is never cleared — "was granted at some
// point" stays true across a revocation, which is exactly what the
// lost-access warning needs. Re-granting clears the warning purely through
// the *current* status.

import Foundation
import Photos

public enum PhotosAccessMemory {

    private static let grantedKey = "maple.photosAccessWasGranted"

    /// Latch the memory when `status` is a granted state. Safe to call on
    /// every authorization-status read — non-granted states are ignored,
    /// never unlearned.
    public static func record(_ status: PHAuthorizationStatus,
                              defaults: UserDefaults = .standard) {
        guard status == .authorized || status == .limited else { return }
        // Idempotent: status reads happen on every sidebar refresh, so skip
        // the defaults write once the latch is already set.
        guard !defaults.bool(forKey: grantedKey) else { return }
        defaults.set(true, forKey: grantedKey)
    }

    /// Latch the memory from indirect evidence of a past grant — e.g. a
    /// configured PhotoKit backup, which could only have been set up with
    /// library access in hand. Covers users whose grant was revoked before
    /// this memory existed to observe it directly.
    public static func latchGrantEvidence(defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: grantedKey)
    }

    /// True when access was granted in some earlier session but the current
    /// status no longer allows library reads — the "we lost permission"
    /// condition the sidebar warns about. Never true for a user who has
    /// simply not been asked yet.
    public static func lostAccess(current: PHAuthorizationStatus,
                                  defaults: UserDefaults = .standard) -> Bool {
        let stillGranted = current == .authorized || current == .limited
        return defaults.bool(forKey: grantedKey) && !stillGranted
    }
}
