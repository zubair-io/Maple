// RenameReconciliationLogicTests — the closed-app external-rename matcher
// (#2657). No filesystem here: ReconcileFingerprints is pure over supplied
// dictionaries, matching the ticket's instruction to keep the decision
// logic (diff, fingerprint match, exactly-one guard) fully testable without
// a live watcher or WinUI. RenameIndexStoreTests covers the persisted
// snapshot side; ExternalRenameReconciliationScanTests covers the two
// wired together against real temp-dir files.

using System;
using System.Collections.Generic;
using Maple.WinUI.Services.FileOperations;
using Xunit;

using Fingerprint = Maple.WinUI.Services.FileOperations.RenameReconciliationLogic.Fingerprint;

namespace Maple.WinUI.Tests
{
    public class RenameReconciliationLogicTests
    {
        private static readonly DateTime CaptureA = new(2026, 5, 1, 10, 0, 0, DateTimeKind.Utc);
        private static readonly DateTime CaptureB = new(2026, 5, 2, 11, 0, 0, DateTimeKind.Utc);

        [Fact]
        public void OneMissing_OneMatchingCandidate_Reconciles()
        {
            var missing = new Dictionary<string, Fingerprint>
            {
                ["IMG_0001.CR3"] = new Fingerprint(12_000_000, CaptureA, "SN123"),
            };
            var unknown = new Dictionary<string, Fingerprint>
            {
                ["Wedding_001.CR3"] = new Fingerprint(12_000_000, CaptureA, "SN123"),
            };

            var result = RenameReconciliationLogic.ReconcileFingerprints(missing, unknown);

            var reconciliation = Assert.Single(result);
            Assert.Equal("IMG_0001.CR3", reconciliation.MissingFileName);
            Assert.Equal("Wedding_001.CR3", reconciliation.NewFileName);
        }

        // NOTE (#2845): this test used to be named
        // `CaptureTimeAloneIsEnough_SerialNotRequired` and asserted a
        // single result under the OLD (wrong) OR contract — "capture time
        // agreeing was sufficient on its own, serial wasn't required at
        // all." That framing was misleading even though the assertion
        // happens to still hold under the corrected AND contract: capture
        // time is mandatory and matches here, and the serial component is
        // satisfied by MUTUAL ABSENCE (both null), not by "serial doesn't
        // matter." Renamed + recommented to state the real rule; the
        // outcome (single match) is unchanged.
        [Fact]
        public void CaptureTimeMatches_AndSerialMutuallyAbsent_Reconciles()
        {
            var missing = new Dictionary<string, Fingerprint>
            {
                ["a.dng"] = new Fingerprint(500, CaptureA, CameraSerial: null),
            };
            var unknown = new Dictionary<string, Fingerprint>
            {
                ["b.dng"] = new Fingerprint(500, CaptureA, CameraSerial: null),
            };

            var result = RenameReconciliationLogic.ReconcileFingerprints(missing, unknown);

            Assert.Single(result);
        }

        // NOTE (#2845): this test used to be named
        // `SerialAloneIsEnough_CaptureTimeNotRequired` and asserted a
        // SINGLE result — i.e. that a matching serial with NO capture time
        // on either side was enough to reconcile. That pinned the bug this
        // ticket fixes: capture time is mandatory on both the API
        // (rename-reconcile.ts's `missingFingerprint`/`newFileFingerprint`
        // return `null` — excluding the file from fingerprinting entirely —
        // whenever `capturedAt` can't be read) and Apple
        // (`ExternalRenameFingerprint.live` returns `nil` rather than a
        // size-only fingerprint under the same condition). A fingerprint
        // with no capture time on either side must now decline, not
        // reconcile on serial alone — flipped to `Assert.Empty` to match.
        [Fact]
        public void SerialMatches_ButCaptureTimeMissingOnBothSides_Declines()
        {
            var missing = new Dictionary<string, Fingerprint>
            {
                ["a.dng"] = new Fingerprint(500, CaptureTimeUtc: null, CameraSerial: "SN999"),
            };
            var unknown = new Dictionary<string, Fingerprint>
            {
                ["b.dng"] = new Fingerprint(500, CaptureTimeUtc: null, CameraSerial: "SN999"),
            };

            var result = RenameReconciliationLogic.ReconcileFingerprints(missing, unknown);

            Assert.Empty(result);
        }

        [Fact]
        public void CaptureTimeUnreadableOnOneSide_ExcludesTheCandidateEntirely_Declines()
        {
            // Capture time present + matching on the known side but
            // unreadable (null) on the candidate side — the candidate must
            // never fall back to matching on size + serial alone.
            var missing = new Dictionary<string, Fingerprint>
            {
                ["a.dng"] = new Fingerprint(500, CaptureA, "SN1"),
            };
            var unknown = new Dictionary<string, Fingerprint>
            {
                ["b.dng"] = new Fingerprint(500, null, "SN1"),
            };

            var result = RenameReconciliationLogic.ReconcileFingerprints(missing, unknown);

            Assert.Empty(result);
        }

        [Fact]
        public void SerialPresentOnOneSideOnly_IsADisagreement_NotAWildcard_Declines()
        {
            // Same size, same capture time, but the serial is present on
            // only one side — per the API's fingerprint-bucket key (a
            // missing serial folds to '', not a wildcard) and Apple's
            // Hashable struct equality (nil != "SN1"), this is a
            // disagreement, not a mutual-absence pass, and must decline.
            var missing = new Dictionary<string, Fingerprint>
            {
                ["a.dng"] = new Fingerprint(500, CaptureA, CameraSerial: "SN1"),
            };
            var unknown = new Dictionary<string, Fingerprint>
            {
                ["b.dng"] = new Fingerprint(500, CaptureA, CameraSerial: null),
            };

            var result = RenameReconciliationLogic.ReconcileFingerprints(missing, unknown);

            Assert.Empty(result);
        }

        // NOTE: "both serials absent but capture times equal must match" is
        // already covered above by CaptureTimeMatches_AndSerialMutuallyAbsent_Reconciles
        // (the renamed former CaptureTimeAloneIsEnough_SerialNotRequired) —
        // verified against Apple's testCameraSerialIsNotRequiredToMatch,
        // which is the source of truth that mutual absence IS a pass, not
        // a decline.

        [Fact]
        public void TwoDifferentPhotos_SharingOnlyASize_NeverMerge()
        {
            // The false-positive shape #2845 was filed over: two DIFFERENT
            // photos from the same camera body (same serial — the normal
            // case) that happen to share a file size. Different capture
            // times must decline this, not merge on size + serial alone.
            var missing = new Dictionary<string, Fingerprint>
            {
                ["beach.dng"] = new Fingerprint(2_000_000, CaptureA, "SN1"),
            };
            var unknown = new Dictionary<string, Fingerprint>
            {
                ["mountain.dng"] = new Fingerprint(2_000_000, CaptureB, "SN1"),
            };

            var result = RenameReconciliationLogic.ReconcileFingerprints(missing, unknown);

            Assert.Empty(result);
        }

        [Fact]
        public void SizeAlone_NeverMerges_EvenWhenItIsTheOnlyCandidate()
        {
            // The acceptance criterion, verbatim: two different photos must
            // never be merged just because they share a file size. Neither
            // side carries a capture time or serial here — size is all
            // there is, so this must decline, not merge.
            var missing = new Dictionary<string, Fingerprint>
            {
                ["a.dng"] = new Fingerprint(500, null, null),
            };
            var unknown = new Dictionary<string, Fingerprint>
            {
                ["b.dng"] = new Fingerprint(500, null, null),
            };

            var result = RenameReconciliationLogic.ReconcileFingerprints(missing, unknown);

            Assert.Empty(result);
        }

        [Fact]
        public void DifferentSize_NeverMerges_EvenWithMatchingCaptureTime()
        {
            var missing = new Dictionary<string, Fingerprint>
            {
                ["a.dng"] = new Fingerprint(500, CaptureA, "SN1"),
            };
            var unknown = new Dictionary<string, Fingerprint>
            {
                ["b.dng"] = new Fingerprint(999, CaptureA, "SN1"),
            };

            var result = RenameReconciliationLogic.ReconcileFingerprints(missing, unknown);

            Assert.Empty(result);
        }

        [Fact]
        public void TwoCandidatesForOneMissing_Declines()
        {
            var missing = new Dictionary<string, Fingerprint>
            {
                ["a.dng"] = new Fingerprint(500, CaptureA, "SN1"),
            };
            var unknown = new Dictionary<string, Fingerprint>
            {
                ["b.dng"] = new Fingerprint(500, CaptureA, "SN1"),
                ["c.dng"] = new Fingerprint(500, CaptureA, "SN1"),
            };
            var declined = new List<string>();

            var result = RenameReconciliationLogic.ReconcileFingerprints(missing, unknown, declined.Add);

            Assert.Empty(result);
            Assert.Single(declined);
        }

        [Fact]
        public void OneCandidateClaimedByTwoMissing_DeclinesBoth()
        {
            // The reverse ambiguity: two vanished photos both fingerprint-
            // match the SAME surviving file. Neither can be trusted, so
            // both decline rather than picking one arbitrarily.
            var missing = new Dictionary<string, Fingerprint>
            {
                ["a.dng"] = new Fingerprint(500, CaptureA, "SN1"),
                ["b.dng"] = new Fingerprint(500, CaptureA, "SN1"),
            };
            var unknown = new Dictionary<string, Fingerprint>
            {
                ["c.dng"] = new Fingerprint(500, CaptureA, "SN1"),
            };
            var declined = new List<string>();

            var result = RenameReconciliationLogic.ReconcileFingerprints(missing, unknown, declined.Add);

            Assert.Empty(result);
            Assert.Single(declined);
        }

        [Fact]
        public void DistinctMissingAndDistinctCandidates_EachResolvesIndependently()
        {
            var missing = new Dictionary<string, Fingerprint>
            {
                ["a.dng"] = new Fingerprint(500, CaptureA, "SN1"),
                ["x.dng"] = new Fingerprint(700, CaptureB, "SN2"),
            };
            var unknown = new Dictionary<string, Fingerprint>
            {
                ["b.dng"] = new Fingerprint(500, CaptureA, "SN1"),
                ["y.dng"] = new Fingerprint(700, CaptureB, "SN2"),
            };

            var result = RenameReconciliationLogic.ReconcileFingerprints(missing, unknown);

            Assert.Equal(2, result.Count);
        }

        [Fact]
        public void NoMissingFiles_ReturnsEmptyWithoutCallingFingerprintCallback()
        {
            var calls = 0;
            var result = RenameReconciliationLogic.Reconcile(
                previousSnapshot: new Dictionary<string, Fingerprint>(),
                currentFileNames: new[] { "new.dng" },
                fingerprintOfCurrentFile: _ => { calls++; return new Fingerprint(1, null, null); });

            Assert.Empty(result);
            Assert.Equal(0, calls);    // the common case (nothing vanished) must cost nothing
        }

        [Fact]
        public void Reconcile_DiffsPreviousSnapshotAgainstCurrentFileNames()
        {
            var previous = new Dictionary<string, Fingerprint>(StringComparer.OrdinalIgnoreCase)
            {
                ["IMG_0001.CR3"] = new Fingerprint(1234, CaptureA, "SN1"),
                ["IMG_0002.CR3"] = new Fingerprint(5678, CaptureB, "SN1"),
            };
            // IMG_0001.CR3 vanished; IMG_0002.CR3 is untouched;
            // Wedding_001.CR3 is new and fingerprint-matches the vanished file.
            var current = new[] { "IMG_0002.CR3", "Wedding_001.CR3" };

            var result = RenameReconciliationLogic.Reconcile(
                previous, current,
                name => name == "Wedding_001.CR3" ? new Fingerprint(1234, CaptureA, "SN1") : null);

            var reconciliation = Assert.Single(result);
            Assert.Equal("IMG_0001.CR3", reconciliation.MissingFileName);
            Assert.Equal("Wedding_001.CR3", reconciliation.NewFileName);
        }
    }
}
