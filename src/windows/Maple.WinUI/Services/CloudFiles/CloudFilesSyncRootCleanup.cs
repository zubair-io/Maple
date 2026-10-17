// The cldapi-free half of disabling the Maple Cloud sync root (#4756).
// `%USERPROFILE%\Maple Cloud` is not purely re-creatable from the server:
// Explorer-side writes are never uploaded (no NOTIFY_* callbacks), and a
// hydrated placeholder the user edited is the only copy of that edit. So
// unregistering removes exactly the items the removal probes vouch for —
// in-sync placeholders Maple itself created — and leaves everything else
// where it is. Nothing here deletes recursively, nothing here throws past
// a single item, and a directory goes only once it is empty. The probes
// (CfGetPlaceholderStateFromAttributeTag, deleting through the handle they
// probed) live in CloudFilesPlaceholderProbe.cs so this file links into
// Maple.WinUI.Tests.

using System;
using System.IO;

namespace Maple.WinUI.Services.CloudFiles
{
    internal readonly record struct CleanupResult(int Removed, int Preserved);

    internal enum RemovalOutcome
    {
        /// <summary>Not an approved placeholder; the sweep decides what
        /// else to do with it (enter a directory, keep a file).</summary>
        NotEligible,
        Removed,
        /// <summary>Approved but could not be removed — locked, read-only,
        /// not empty. Kept, and never entered.</summary>
        Failed,
    }

    /// <summary>The two removal probes. Each classifies and, when the item
    /// qualifies, deletes it in one step through the same handle, so a
    /// rename or replacement racing the sweep cannot redirect the delete.
    /// <see cref="TryRemoveUnmodifiedPlaceholder"/> takes a file or an
    /// empty directory that is an in-sync placeholder — a folder the user
    /// made in Explorer is not one and stays even when empty;
    /// <see cref="TryRemoveUnpopulatedPlaceholderDirectory"/> takes a
    /// directory placeholder that was never populated, which holds nothing
    /// local and must go without being entered — entering it would ask the
    /// provider to populate it first.</summary>
    internal sealed record CleanupProbes(
        Func<string, RemovalOutcome> TryRemoveUnmodifiedPlaceholder,
        Func<string, RemovalOutcome> TryRemoveUnpopulatedPlaceholderDirectory);

    internal static class CloudFilesSyncRootCleanup
    {
        /// <summary>Walks <paramref name="root"/> bottom-up through the
        /// probes; the root itself goes only once nothing was preserved
        /// beneath it. Any probe failure keeps the item and the sweep
        /// carries on; symlinks and junctions are kept and not entered.</summary>
        internal static CleanupResult Sweep(string root, CleanupProbes probes)
        {
            if (!Directory.Exists(root))
                return new CleanupResult(0, 0);
            var result = SweepDirectory(root, probes);
            if (result.Preserved == 0)
                Attempt(_ => { Directory.Delete(root); return RemovalOutcome.Removed; }, root);
            return result;
        }

        private static CleanupResult SweepDirectory(string directory, CleanupProbes probes)
        {
            string[] children;
            string[] files;
            try
            {
                children = Directory.GetDirectories(directory);
                files = Directory.GetFiles(directory);
            }
            catch (Exception)
            {
                return new CleanupResult(0, 1);
            }

            var removed = 0;
            var preserved = 0;
            foreach (var child in children)
            {
                if (IsLink(child))
                {
                    preserved++;
                    continue;
                }
                var unpopulated = Attempt(probes.TryRemoveUnpopulatedPlaceholderDirectory, child);
                if (unpopulated != RemovalOutcome.NotEligible)
                {
                    Count(unpopulated, ref removed, ref preserved);
                    continue;
                }
                var nested = SweepDirectory(child, probes);
                removed += nested.Removed;
                preserved += nested.Preserved;
                if (nested.Preserved > 0)
                    continue;
                if (Attempt(probes.TryRemoveUnmodifiedPlaceholder, child) != RemovalOutcome.Removed)
                    preserved++;
            }
            foreach (var file in files)
                Count(Attempt(probes.TryRemoveUnmodifiedPlaceholder, file), ref removed, ref preserved);
            return new CleanupResult(removed, preserved);
        }

        private static void Count(RemovalOutcome outcome, ref int removed, ref int preserved)
        {
            if (outcome == RemovalOutcome.Removed)
                removed++;
            else
                preserved++;
        }

        /// <summary>Symlink or junction — not a cloud placeholder, which is
        /// also a reparse point but reports no link target.</summary>
        private static bool IsLink(string directory)
        {
            try { return new DirectoryInfo(directory).LinkTarget != null; }
            catch (Exception) { return true; }
        }

        private static RemovalOutcome Attempt(Func<string, RemovalOutcome> probe, string path)
        {
            try { return probe(path); }
            catch (Exception) { return RemovalOutcome.Failed; }
        }

        /// <summary>Why Start() must not adopt <paramref name="root"/>, or
        /// null when it may: a folder that already exists, holds anything,
        /// and is not Maple's own registered sync root is either the user's
        /// "Maple Cloud" folder or another provider's root — registering
        /// over it would turn its contents into what a later disable sweeps.</summary>
        internal static string? AdoptionRefusal(string root, bool isMapleSyncRoot)
        {
            if (isMapleSyncRoot || !Directory.Exists(root))
                return null;
            using var entries = Directory.EnumerateFileSystemEntries(root).GetEnumerator();
            return entries.MoveNext()
                ? $"The folder {root} already exists and is not empty. Move its contents elsewhere, then enable Maple Cloud in File Explorer again."
                : null;
        }
    }
}
