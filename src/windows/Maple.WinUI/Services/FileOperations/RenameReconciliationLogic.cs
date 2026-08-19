// RenameReconciliationLogic.cs — the closed-app fallback for external
// renames (#2657). Windows has a live path that needs none of this:
// FileSystemWatcher's Renamed event carries both old and new paths while
// the app is running, so a rename observed live is followed directly (see
// LibraryWatcher.cs's RenamesReady / EditSessionViewModel.Watcher.cs). This
// class exists purely for the gap live-watching cannot cover — a rename
// that happened while Maple was closed, where the only evidence on the next
// scan is "a file Maple knew about is gone" and "a file Maple never saw
// before has appeared."
//
// WinUI-free by construction (plain collections, no filesystem access — the
// caller supplies fingerprints) so it links into Maple.WinUI.Tests via this
// directory's existing `Services\FileOperations\*.cs` wildcard include, the
// same way LocalFileOperations.cs and its siblings do. Production wiring
// (EditSessionViewModel's folder-scan path) supplies the real EXIF/size
// reader; tests supply canned fingerprints, so the decision logic here is
// fully exercisable without a live filesystem or WinUI.
//
// The one invariant every acceptance criterion for this ticket hangs off:
// never merge two different photos that merely share a file size. Two RAWs
// from the same camera at the same resolution collide on size constantly;
// size alone is treated as necessary, never sufficient.
//
// The match relation mirrors the API (src/api/src/workers/discover/
// rename-reconcile.ts) and Apple (ExternalRenameMatcher.swift +
// ExternalRenameFingerprint+Live.swift, #2656) exactly (#2845): size AND
// capture time AND serial-agreement-or-mutual-absence, with capture time
// MANDATORY — a fingerprint whose capture time couldn't be read never
// matches, on either side, regardless of what else lines up.

using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.WinUI.Services.FileOperations
{
    public static class RenameReconciliationLogic
    {
        /// <summary>The cheap, non-checksum signature this heuristic matches
        /// on: RAWs are large, so a full hash is off the table for a
        /// per-scan comparison. Size is mandatory but never sufficient by
        /// itself (see this file's header) — capture time must ALSO agree
        /// (mandatory on both sides; a missing/unreadable capture time
        /// never matches), and camera serial must agree-or-be-mutually-
        /// absent. <see cref="CaptureTimeUtc"/> and <see
        /// cref="CameraSerial"/> are nullable only because a real read can
        /// fail — the caller is expected to pass <c>null</c> when EXIF
        /// couldn't be read, never a placeholder value.</summary>
        public readonly record struct Fingerprint(long FileSizeBytes, DateTime? CaptureTimeUtc, string? CameraSerial);

        /// <summary>One resolved rename: <paramref name="MissingFileName"/>
        /// (the vanished, previously-known name) is believed to now be
        /// <paramref name="NewFileName"/> (the file that appeared in its
        /// place), both bare file names within the SAME folder the caller
        /// scoped its inputs to.</summary>
        public sealed record Reconciliation(string MissingFileName, string NewFileName);

        /// <summary>
        /// Diffs <paramref name="previousSnapshot"/> (every file this folder
        /// held as of the last successful scan, keyed by bare file name)
        /// against <paramref name="currentFileNames"/> (every file present
        /// right now) to find candidates, then matches on fingerprint.
        /// <paramref name="fingerprintOfCurrentFile"/> is only ever called
        /// for a file name that is NEW (absent from the previous snapshot)
        /// AND only when at least one previously-known file has actually
        /// gone missing — the common case (nothing vanished) costs nothing
        /// beyond the two set differences.
        /// </summary>
        public static IReadOnlyList<Reconciliation> Reconcile(
            IReadOnlyDictionary<string, Fingerprint> previousSnapshot,
            IReadOnlyCollection<string> currentFileNames,
            Func<string, Fingerprint?> fingerprintOfCurrentFile,
            Action<string>? onDeclined = null)
        {
            var currentSet = new HashSet<string>(currentFileNames, StringComparer.OrdinalIgnoreCase);
            var missing = previousSnapshot
                .Where(kv => !currentSet.Contains(kv.Key))
                .ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.OrdinalIgnoreCase);
            if (missing.Count == 0)
                return Array.Empty<Reconciliation>();

            var newNames = currentFileNames
                .Where(name => !previousSnapshot.ContainsKey(name))
                .ToList();
            if (newNames.Count == 0)
                return Array.Empty<Reconciliation>();

            var newUnknown = new Dictionary<string, Fingerprint>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in newNames)
            {
                if (fingerprintOfCurrentFile(name) is { } fp)
                    newUnknown[name] = fp;
            }

            return ReconcileFingerprints(missing, newUnknown, onDeclined);
        }

        /// <summary>The pure matcher, split out from <see cref="Reconcile"/>
        /// so a test can drive it with hand-built fingerprint dictionaries
        /// directly — no directory diffing, no fingerprint callback.
        /// </summary>
        public static IReadOnlyList<Reconciliation> ReconcileFingerprints(
            IReadOnlyDictionary<string, Fingerprint> missingKnownFiles,
            IReadOnlyDictionary<string, Fingerprint> newUnknownFiles,
            Action<string>? onDeclined = null)
        {
            var candidateMatches = new List<Reconciliation>();
            foreach (var (missingName, missingFp) in missingKnownFiles)
            {
                var candidates = newUnknownFiles
                    .Where(kv => Matches(missingFp, kv.Value))
                    .Select(kv => kv.Key)
                    .ToList();

                switch (candidates.Count)
                {
                    case 0:
                        break;
                    case 1:
                        candidateMatches.Add(new Reconciliation(missingName, candidates[0]));
                        break;
                    default:
                        onDeclined?.Invoke(
                            $"{missingName}: {candidates.Count} same-fingerprint candidates in this folder "
                            + $"({string.Join(", ", candidates)}) — declining, ambiguous.");
                        break;
                }
            }

            // A new file claimed by more than one missing path is ALSO
            // ambiguous — two different vanished photos must never both
            // resolve to the same surviving file.
            var resolved = new List<Reconciliation>();
            foreach (var group in candidateMatches.GroupBy(r => r.NewFileName, StringComparer.OrdinalIgnoreCase))
            {
                var groupList = group.ToList();
                if (groupList.Count == 1)
                {
                    resolved.Add(groupList[0]);
                }
                else
                {
                    onDeclined?.Invoke(
                        $"{group.Key}: matches {groupList.Count} missing files "
                        + $"({string.Join(", ", groupList.Select(r => r.MissingFileName))}) — declining, ambiguous.");
                }
            }
            return resolved;
        }

        /// <summary>Size is mandatory but never sufficient alone. Capture
        /// time must ALSO agree, and is itself mandatory on both sides — a
        /// fingerprint whose capture time is <c>null</c> (unreadable EXIF)
        /// never matches anything, matching the API's
        /// <c>missingFingerprint</c>/<c>newFileFingerprint</c> (which
        /// exclude such a file from fingerprinting entirely) and Apple's
        /// <c>ExternalRenameFingerprint.live</c> (which returns
        /// <c>nil</c> rather than a size-only fingerprint). Camera serial
        /// is the third component: it must agree, OR be absent on BOTH
        /// sides — a serial present on only one side is a disagreement,
        /// not a pass, mirroring the API's fingerprint-bucket key (which
        /// folds a missing serial to <c>''</c> rather than treating it as a
        /// wildcard) and Apple's <c>Hashable</c> struct equality (where
        /// <c>nil != "SN1"</c>).</summary>
        private static bool Matches(Fingerprint known, Fingerprint candidate)
        {
            if (known.FileSizeBytes != candidate.FileSizeBytes)
                return false;

            var captureMatches = known.CaptureTimeUtc is { } kt
                && candidate.CaptureTimeUtc is { } ct
                && kt == ct;
            if (!captureMatches)
                return false;

            return string.Equals(known.CameraSerial, candidate.CameraSerial, StringComparison.Ordinal);
        }
    }
}
