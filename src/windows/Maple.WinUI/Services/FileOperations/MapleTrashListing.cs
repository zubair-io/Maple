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
        /// <summary>Survives a permission hole partway down a subtree
        /// (common on SMB shares) instead of aborting the whole walk on the
        /// first inaccessible subdirectory — the plain
        /// <see cref="SearchOption.AllDirectories"/> overload does not
        /// survive that (#2743 review WARN finding).</summary>
        private static readonly EnumerationOptions TrashEnumerationOptions = new()
        {
            IgnoreInaccessible = true,
            RecurseSubdirectories = true,
        };

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
        /// fixture. <paramref name="stat"/> is the size/last-write lookup
        /// for one primary path — injectable (defaults to a real
        /// <see cref="FileInfo"/> read) so a test can simulate one entry
        /// vanishing or being locked between discovery and stat (a real
        /// possibility on SMB — see this method's own try/catch below)
        /// without depending on an actual race.</summary>
        internal static IReadOnlyList<TrashListItem> ListTrashItemsForRoot(
            string libraryRoot, Func<string, (long SizeBytes, DateTime LastWriteUtc)>? stat = null)
        {
            stat ??= StatFile;
            var trashRoot = Path.Combine(TrashPaths.NormalizeDir(Path.GetFullPath(libraryRoot)), ".maple", "trash");
            if (!Directory.Exists(trashRoot))
                return Array.Empty<TrashListItem>();

            var items = new List<TrashListItem>();
            foreach (var primaryPath in Directory.EnumerateFiles(trashRoot, "*", TrashEnumerationOptions))
            {
                // Sidecars are surfaced alongside their primary
                // (TrashSidecarPath below), never as their own row — an
                // orphaned .xmp with no matching primary (shouldn't happen
                // given TrashAsync always moves both together, but not
                // impossible after a partial failure) is silently excluded
                // rather than shown as a restorable "asset". `.origpath`
                // marker files (LocalFileOperations.TrashRestore.cs, #2743
                // review fix) are this module's own bookkeeping — never a
                // restorable asset either.
                var extension = Path.GetExtension(primaryPath);
                if (string.Equals(extension, ".xmp", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(extension, ".origpath", StringComparison.OrdinalIgnoreCase))
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

                // #2743 review BLOCKING finding: FileInfo does no I/O of its
                // own — the actual disk access happens lazily the first
                // time .Length/.LastWriteTimeUtc is read. Reading them
                // OUTSIDE this try (as the previous version did, via a bare
                // `new FileInfo(primaryPath)` inside the try and property
                // reads at the item-construction call below) meant a file
                // that vanished or got locked between enumeration and this
                // point — plausible on an SMB share — threw
                // FileNotFoundException/IOException past every catch here
                // and crashed the WHOLE listing, breaking the Restore
                // dialog for every other item too. Both reads now happen
                // inside the try, into locals; a failure here skips just
                // this one entry — it's gone or locked, and either a
                // concurrent trash sweep or the next time this dialog opens
                // will reflect its real state.
                long sizeBytes;
                DateTime lastWriteUtc;
                try
                {
                    (sizeBytes, lastWriteUtc) = stat(primaryPath);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    continue;
                }

                items.Add(new TrashListItem(
                    libraryRoot, primaryPath, sidecarPath, relativePath,
                    Path.GetFileName(primaryPath), sizeBytes, lastWriteUtc));
            }
            return items;
        }

        private static (long SizeBytes, DateTime LastWriteUtc) StatFile(string path)
        {
            var info = new FileInfo(path);
            return (info.Length, info.LastWriteTimeUtc);
        }
    }
}
