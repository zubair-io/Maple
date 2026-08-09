// MapleTrashListing.cs — enumerates `.maple/trash/<rel>` across the app's
// open library roots for the minimal in-app restore surface (#2654). Local
// fixed-drive deletes go to the OS Recycle Bin (restored from Explorer, not
// here — see LocalFileOperations.Trash.cs); this listing only ever surfaces
// items that landed in Maple's OWN trash — SMB shares (no reliable
// per-share recycle bin), and any local delete where the Recycle Bin call
// itself failed.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.FileOperations
{
    /// <summary>One item sitting in `&lt;LibraryRoot&gt;/.maple/trash/…`,
    /// ready to restore. <paramref name="RelativePath"/> is the path (from
    /// <paramref name="LibraryRoot"/>) it will return to.</summary>
    public sealed record TrashListItem(
        string LibraryRoot,
        string TrashPrimaryPath,
        string? TrashSidecarPath,
        string RelativePath,
        string FileName,
        long SizeBytes,
        DateTime TrashedUtc)
    {
        /// <summary>Single-line label for a plain
        /// <c>ListView.DisplayMemberPath</c> row (MainWindow.TrashRestore.cs)
        /// — filename plus its original relative location, so two
        /// same-named files trashed from different folders stay
        /// distinguishable.</summary>
        public string DisplayLabel => $"{FileName}  —  {RelativePath}";
    }

    public static class MapleTrashListing
    {
        /// <summary>Every item across all of <paramref name="libraryRoots"/>'s
        /// `.maple/trash`, most-recently-trashed first (by the trash-side
        /// file's own last-write time — an approximation, since no separate
        /// trashed-at timestamp is tracked anywhere in this module).</summary>
        public static IReadOnlyList<TrashListItem> ListTrashItems(IEnumerable<string> libraryRoots)
        {
            var items = new List<TrashListItem>();
            foreach (var root in libraryRoots.Distinct(StringComparer.OrdinalIgnoreCase))
                items.AddRange(ListTrashItemsForRoot(root));
            return items.OrderByDescending(i => i.TrashedUtc).ToList();
        }

        /// <summary>Single-root scan — split out so it stays directly
        /// testable against one temp directory without needing a multi-root
        /// fixture.</summary>
        internal static IReadOnlyList<TrashListItem> ListTrashItemsForRoot(string libraryRoot)
        {
            var trashRoot = Path.Combine(TrashPaths.NormalizeDir(Path.GetFullPath(libraryRoot)), ".maple", "trash");
            if (!Directory.Exists(trashRoot))
                return Array.Empty<TrashListItem>();

            var items = new List<TrashListItem>();
            foreach (var primaryPath in Directory.EnumerateFiles(trashRoot, "*", SearchOption.AllDirectories))
            {
                // Sidecars are surfaced alongside their primary
                // (TrashSidecarPath below), never as their own row — an
                // orphaned .xmp with no matching primary (shouldn't happen
                // given TrashAsync always moves both together, but not
                // impossible after a partial failure) is silently excluded
                // rather than shown as a restorable "asset".
                if (string.Equals(Path.GetExtension(primaryPath), ".xmp", StringComparison.OrdinalIgnoreCase))
                    continue;

                string? sidecarPath;
                try
                {
                    var candidate = SidecarStore.SidecarPathFor(primaryPath);
                    sidecarPath = File.Exists(candidate) ? candidate : null;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    sidecarPath = null;
                }

                string relativePath;
                try
                {
                    relativePath = LocalFileOperations.ComputeOriginalRelativePath(primaryPath, libraryRoot);
                }
                catch (FileOperationException)
                {
                    continue; // defensive — unreachable given the enumeration root above
                }

                FileInfo info;
                try
                {
                    info = new FileInfo(primaryPath);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    continue;
                }

                items.Add(new TrashListItem(
                    libraryRoot, primaryPath, sidecarPath, relativePath,
                    Path.GetFileName(primaryPath), info.Length, info.LastWriteTimeUtc));
            }
            return items;
        }
    }
}
