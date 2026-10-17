// The cldapi-free half of disabling the Maple Cloud sync root (#4756).
// `%USERPROFILE%\Maple Cloud` is not purely re-creatable from the server:
// Explorer-side writes are never uploaded (no NOTIFY_* callbacks), and a
// hydrated placeholder the user edited is the only copy of that edit. So
// unregistering removes exactly the items the placeholder probes vouch for
// — in-sync placeholders Maple itself created — and leaves everything else
// where it is. Nothing here deletes recursively, nothing here throws past
// a single item, and a directory goes only once it is empty. The probes
// (CfGetPlaceholderStateFromAttributeTag) live in CloudFilesPlaceholderProbe.cs
// so this file links into Maple.WinUI.Tests.

using System;
using System.IO;

namespace Maple.WinUI.Services.CloudFiles
{
    internal readonly record struct CleanupResult(int Removed, int Preserved);

    /// <summary>What the sweep may delete. <see cref="IsUnmodifiedPlaceholder"/>
    /// approves a file, or a directory once it is empty — a folder the user
    /// made in Explorer is not a placeholder and stays even when empty;
    /// <see cref="IsUnpopulatedPlaceholderDirectory"/> approves a directory
    /// placeholder that was never populated, so it holds nothing local and
    /// can go without being entered — entering it would ask the provider to
    /// populate it first.</summary>
    internal sealed record CleanupProbes(
        Func<string, bool> IsUnmodifiedPlaceholder,
        Func<string, bool> IsUnpopulatedPlaceholderDirectory);

    internal static class CloudFilesSyncRootCleanup
    {
        /// <summary>Walks <paramref name="root"/> bottom-up, deleting each
        /// item the probes approve; a directory goes only once it is empty
        /// and is itself an approved placeholder, and the root only once
        /// nothing was preserved beneath it. Any probe or delete failure
        /// keeps the item and the sweep carries on; directory reparse
        /// points (junctions, symlinks) are kept and not entered.</summary>
        internal static CleanupResult Sweep(string root, CleanupProbes probes)
        {
            if (!Directory.Exists(root))
                return new CleanupResult(0, 0);
            var result = SweepDirectory(root, probes);
            if (result.Preserved == 0)
                TryDelete(() => Directory.Delete(root));
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
                if (IsReparsePoint(child))
                {
                    preserved++;
                    continue;
                }
                if (Approves(probes.IsUnpopulatedPlaceholderDirectory, child)
                    && TryDelete(() => Directory.Delete(child)))
                {
                    removed++;
                    continue;
                }
                var nested = SweepDirectory(child, probes);
                removed += nested.Removed;
                preserved += nested.Preserved;
                if (nested.Preserved > 0)
                    continue;
                if (Approves(probes.IsUnmodifiedPlaceholder, child) && TryDelete(() => Directory.Delete(child)))
                    continue;
                preserved++;
            }
            foreach (var file in files)
            {
                if (Approves(probes.IsUnmodifiedPlaceholder, file) && TryDelete(() => File.Delete(file)))
                    removed++;
                else
                    preserved++;
            }
            return new CleanupResult(removed, preserved);
        }

        private static bool IsReparsePoint(string directory)
        {
            try { return File.GetAttributes(directory).HasFlag(FileAttributes.ReparsePoint); }
            catch (Exception) { return true; }
        }

        private static bool Approves(Func<string, bool> probe, string path)
        {
            try { return probe(path); }
            catch (Exception) { return false; }
        }

        private static bool TryDelete(Action delete)
        {
            try { delete(); return true; }
            catch (Exception) { return false; }
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
