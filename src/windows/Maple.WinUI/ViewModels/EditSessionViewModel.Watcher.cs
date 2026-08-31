// EditSessionViewModel.Watcher.cs — live grid updates for the browsed
// folder (#2585): new files join the grid (sorted, hydrated), deleted files
// leave it. Split out of EditSessionViewModel.Library.cs (#2754) to
// stay under this codebase's line-budget after the #2651
// drop-to-mount additions — same reasoning as that file's own prior split
// note (#2639) and EditSessionViewModel.DropMount.cs's.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        /// <summary>Cloud browsing stops the watcher (LoadCloudFolderAsync
        /// has no local dir).</summary>
        private void WatchBrowsedFolder(string folderPath)
        {
            _libraryWatcher ??= CreateLibraryWatcher();
            _libraryWatcher.Watch(folderPath);
        }

        private LibraryWatcher CreateLibraryWatcher()
        {
            var watcher = new LibraryWatcher(
                path => SupportedExtensions.Contains(Path.GetExtension(path)));
            watcher.ChangesReady += (added, removed) =>
            {
                // Build the new items off the watcher thread (FileInfo + sidecar
                // read), then apply the whole batch on the dispatcher.
                var folder = CurrentFolderPath;
                var items = added
                    .Where(p => string.Equals(Path.GetDirectoryName(p), folder, StringComparison.OrdinalIgnoreCase))
                    .Select(filePath =>
                    {
                        try
                        {
                            var info = new FileInfo(filePath);
                            var item = new PhotoItem
                            {
                                FilePath = filePath,
                                FileName = info.Name,
                                Format = info.Extension.TrimStart('.').ToUpperInvariant(),
                                FileSizeBytes = info.Length,
                                FileModifiedUtc = info.LastWriteTimeUtc,
                            };
                            var sidecar = SidecarStore.Load(filePath);
                            if (sidecar != null)
                            {
                                item.Rating = sidecar.Rating ?? 0;
                                item.FlagStatus = sidecar.Flag ?? "none";
                                item.ColorLabel = sidecar.ColorLabel;
                            }
                            return item;
                        }
                        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                        {
                            return null;
                        }
                    })
                    .Where(item => item != null)
                    .Select(item => item!)
                    .ToList();

                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    if (!string.Equals(CurrentFolderPath, folder, StringComparison.OrdinalIgnoreCase))
                        return;    // user navigated away while the batch settled
                    var changed = false;
                    foreach (var path in removed)
                    {
                        var victim = AllPhotos.FirstOrDefault(p =>
                            string.Equals(p.FilePath, path, StringComparison.OrdinalIgnoreCase));
                        if (victim == null)
                            continue;
                        AllPhotos.Remove(victim);
                        if (ReferenceEquals(SelectedPhoto, victim))
                            SelectedPhoto = null;
                        changed = true;
                    }
                    foreach (var item in items)
                    {
                        if (AllPhotos.Any(p => string.Equals(p.FilePath, item.FilePath, StringComparison.OrdinalIgnoreCase)))
                            continue;
                        var at = AllPhotos.TakeWhile(p =>
                            string.Compare(p.FilePath, item.FilePath, StringComparison.OrdinalIgnoreCase) < 0).Count();
                        AllPhotos.Insert(at, item);
                        changed = true;
                    }
                    if (!changed)
                        return;
                    ApplyFilters();
                    Timeline.GroupPhotosByDate(AllPhotos);
                    if (items.Count > 0)
                        _ = Task.Run(() => HydrateLibraryAsync(items, null, CancellationToken.None));
                });
            };
            watcher.RenamesReady += ApplyLiveRenames;
            return watcher;
        }

        /// <summary>
        /// A rename observed WHILE THE APP IS RUNNING (#2657) — follows
        /// FileSystemWatcher's Renamed event exactly, no heuristic and no
        /// false-positive risk: the OS already told us the old and new
        /// identity are the same file. The generic added/removed path
        /// (above) would instead drop the old PhotoItem and build a brand
        /// new one from the new name, reading a sidecar that never followed
        /// the rename — this is the orphaning bug the ticket exists to
        /// close. Sidecar move + in-place identity update run here instead.
        ///
        /// Old-path cache cleanup (#2710/#3083): the shared thumbnail cache
        /// is keyed by basename (`.maple\thumbs\&lt;sha256_prefix16(name)&gt;.avif`),
        /// so the OS-observed rename provably orphaned the old name's entry
        /// — reclaim it here, the same best-effort delete the in-app rename
        /// flow gets from `LocalFileOperations.FinalizeRelocate`.
        /// </summary>
        private void ApplyLiveRenames(IReadOnlyList<(string OldPath, string NewPath)> pairs)
        {
            var folder = CurrentFolderPath;
            var reconciled = pairs
                .Where(p => string.Equals(Path.GetDirectoryName(p.OldPath), folder, StringComparison.OrdinalIgnoreCase))
                .Select(p =>
                {
                    LocalFileOperations.TryDelete(ThumbCachePaths.SharedThumbPathFor(p.OldPath));
                    try
                    {
                        RenameSidecarIfPresent(p.OldPath, p.NewPath);
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        // The primary rename already happened on disk — an
                        // item that keeps its identity but loses its edits
                        // to a locked/colliding sidecar move beats orphaning
                        // the grid entry entirely.
                        DiagLog.Write($"[library] sidecar rename failed for {p.OldPath} -> {p.NewPath}: {ex.Message}");
                    }
                    return p;
                })
                .ToList();
            if (reconciled.Count == 0)
                return;

            App.MainDispatcherQueue?.TryEnqueue(() =>
            {
                if (!string.Equals(CurrentFolderPath, folder, StringComparison.OrdinalIgnoreCase))
                    return;    // user navigated away while the batch settled
                var changed = false;
                foreach (var (oldPath, newPath) in reconciled)
                {
                    var photo = AllPhotos.FirstOrDefault(p =>
                        string.Equals(p.FilePath, oldPath, StringComparison.OrdinalIgnoreCase));
                    if (photo == null)
                        continue;    // watcher fired before the item ever loaded — nothing to reconcile
                    ApplyRenameOutcome(photo, newPath);
                    changed = true;
                }
                if (!changed)
                    return;
                ApplyFilters();
                Timeline.GroupPhotosByDate(AllPhotos);
            });
        }

        /// <summary>Moves the `.xmp` sidecar to follow an externally-renamed
        /// primary. `overwrite: false` — a collision at the new sidecar path
        /// means something already occupies that name, and silently
        /// clobbering a stranger's edits is worse than leaving this one
        /// orphaned (caught and logged by the caller).</summary>
        private static void RenameSidecarIfPresent(string oldPrimaryPath, string newPrimaryPath)
        {
            var oldSidecar = SidecarStore.SidecarPathFor(oldPrimaryPath);
            if (!File.Exists(oldSidecar))
                return;
            var newSidecar = SidecarStore.SidecarPathFor(newPrimaryPath);
            File.Move(oldSidecar, newSidecar, overwrite: false);
        }
    }
}
