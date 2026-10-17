// The cldapi-free half of disabling the Maple Cloud sync root (#4756).
// `%USERPROFILE%\Maple Cloud` is not purely re-creatable from the server:
// Explorer-side writes are never uploaded (no NOTIFY_* callbacks), and a
// hydrated placeholder the user edited is the only copy of that edit. So
// unregistering removes exactly the items a placeholder probe vouches for
// — in-sync placeholders Maple itself created — and leaves everything else
// where it is. Nothing here deletes recursively; a directory goes only once
// it is empty. The probe (CfGetPlaceholderStateFromAttributeTag) lives in
// CloudFilesSyncRoot.cs so this file links into Maple.WinUI.Tests.

using System;
using System.IO;

namespace Maple.WinUI.Services.CloudFiles
{
    internal readonly record struct CleanupResult(int Removed, int Preserved);

    internal static class CloudFilesSyncRootCleanup
    {
        /// <summary>Walks <paramref name="root"/> bottom-up, deleting each
        /// file <paramref name="isUnmodifiedPlaceholder"/> approves and each
        /// directory left empty afterwards, the root included. A probe that
        /// throws counts as "not a placeholder": uncertainty keeps the file.</summary>
        internal static CleanupResult Sweep(string root, Func<string, bool> isUnmodifiedPlaceholder)
        {
            if (!Directory.Exists(root))
                return new CleanupResult(0, 0);
            var result = SweepDirectory(root, isUnmodifiedPlaceholder);
            if (result.Preserved == 0)
                Directory.Delete(root);
            return result;
        }

        private static CleanupResult SweepDirectory(string directory, Func<string, bool> isUnmodifiedPlaceholder)
        {
            var removed = 0;
            var preserved = 0;
            foreach (var child in Directory.EnumerateDirectories(directory))
            {
                var nested = SweepDirectory(child, isUnmodifiedPlaceholder);
                removed += nested.Removed;
                preserved += nested.Preserved;
                if (nested.Preserved == 0)
                    Directory.Delete(child);
            }
            foreach (var file in Directory.EnumerateFiles(directory))
            {
                if (ProbeSafely(file, isUnmodifiedPlaceholder))
                {
                    File.Delete(file);
                    removed++;
                }
                else
                {
                    preserved++;
                }
            }
            return new CleanupResult(removed, preserved);
        }

        private static bool ProbeSafely(string file, Func<string, bool> isUnmodifiedPlaceholder)
        {
            try { return isUnmodifiedPlaceholder(file); }
            catch (Exception) { return false; }
        }

        /// <summary>Why Start() must not adopt <paramref name="root"/>, or
        /// null when it may: a folder that already exists, holds anything,
        /// and is not a registered sync root is the user's own "Maple
        /// Cloud" folder — registering over it would turn its contents into
        /// what a later disable sweeps.</summary>
        internal static string? AdoptionRefusal(string root, bool isRegisteredSyncRoot)
        {
            if (isRegisteredSyncRoot || !Directory.Exists(root))
                return null;
            using var entries = Directory.EnumerateFileSystemEntries(root).GetEnumerator();
            return entries.MoveNext()
                ? $"The folder {root} already exists and is not empty. Move its contents elsewhere, then enable Maple Cloud in File Explorer again."
                : null;
        }
    }
}
