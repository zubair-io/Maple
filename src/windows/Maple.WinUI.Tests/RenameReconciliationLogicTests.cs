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

        [Fact]
        public void CaptureTimeAloneIsEnough_SerialNotRequired()
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

        [Fact]
        public void SerialAloneIsEnough_CaptureTimeNotRequired()
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

            Assert.Single(result);
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
