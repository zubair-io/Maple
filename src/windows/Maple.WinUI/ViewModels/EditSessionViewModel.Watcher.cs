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
                path => SupportedExtensions.Contains(Path.GetExtension(path)), RawJpegPairing.IsPairCandidate);
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
                var inventory = ReadPairInventory(folder);

                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    if (!string.Equals(CurrentFolderPath, folder, StringComparison.OrdinalIgnoreCase))
                        return;    // user navigated away while the batch settled
                    var changed = AdoptPairInventory(inventory);
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
            watcher.PairInventoryChanged += () =>
            {
                var folder = CurrentFolderPath;
                var inventory = ReadPairInventory(folder);
                App.MainDispatcherQueue?.TryEnqueue(() =>
                {
                    if (!string.Equals(CurrentFolderPath, folder, StringComparison.OrdinalIgnoreCase)
                        || !AdoptPairInventory(inventory))
                        return;
                    ApplyFilters();
                    Timeline.GroupPhotosByDate(AllPhotos);
                });
            };
            return watcher;
        }

        // The folder's RAW and JPEG names, shown or not, re-read after a change: the
        // watcher reports RAW formats the grid does not open only as "something changed".
        private static HashSet<string>? ReadPairInventory(string? folder) =>
            folder == null ? null : EnumerateImageFiles(folder).PairInventory.ToHashSet(StringComparer.Ordinal);

        private bool AdoptPairInventory(HashSet<string>? inventory)
        {
            if (inventory == null || inventory.SetEquals(_localPairInventory))
                return false;
            _localPairInventory = inventory;
            return true;
        }

        /// <summary>
        /// A rename observed WHILE THE APP IS RUNNING (#2657) — follows
        /// FileSystemWatcher's Renamed event exactly, no heuristic and no
        /// false-positive risk: the OS already told us the old and new
        /// identity are the same file. The generic added/removed path
        /// (above) would instead drop the old PhotoItem and build a brand
        /// new one from the new name, reading a sidecar that never followed
        /// the rename — this is the orphaning bug the ticket exists to
        /// close. The sidecar follow-up obeys the shared-sidecar rule
        /// (`LocalFileOperations.FollowExternalRenames`, #6072), then the
        /// in-place identity update runs.
        ///
        /// Old-path cache cleanup (#2710/#3083): the shared thumbnail cache
        /// is keyed by filename (`.maple\thumbs\&lt;name&gt;.avif`), so the
        /// OS-observed rename provably orphaned the old name's entry and any
        /// legacy hashed `.v25` file — reclaim them here, the same
        /// best-effort cleanup the in-app rename flow gets from
        /// `LocalFileOperations.FinalizeRelocate`.
        /// </summary>
        private void ApplyLiveRenames(IReadOnlyList<(string OldPath, string NewPath)> pairs)
        {
            var folder = CurrentFolderPath;
            var reconciled = pairs
                .Where(p => string.Equals(Path.GetDirectoryName(p.OldPath), folder, StringComparison.OrdinalIgnoreCase))
                .ToList();
            foreach (var rename in reconciled)
                LocalFileOperations.ReclaimSharedThumbs(rename.OldPath, rename.NewPath);
            var followed = LocalFileOperations.FollowExternalRenames(reconciled);
            if (reconciled.Count == 0)
                return;
            var inventory = ReadPairInventory(folder);

            App.MainDispatcherQueue?.TryEnqueue(() =>
            {
                if (!string.Equals(CurrentFolderPath, folder, StringComparison.OrdinalIgnoreCase))
                    return;    // user navigated away while the batch settled
                // Resolve every photo before renaming any: a swap reuses a
                // path another rename in the batch is about to vacate.
                var renamedPhotos = followed
                    .Select(f => (Photo: AllPhotos.FirstOrDefault(p =>
                        string.Equals(p.FilePath, f.OldPath, StringComparison.OrdinalIgnoreCase)), Result: f))
                    .Where(x => x.Photo != null)    // watcher fired before the item ever loaded — nothing to reconcile
                    .ToList();
                var changed = AdoptPairInventory(inventory) | (renamedPhotos.Count > 0);
                // A photo that will read a different sidecar must not autosave
                // its old values under the new path, so its unsaved state goes
                // BEFORE any path changes; a photo that keeps its own sidecar
                // (moved or copied with it) keeps its pending edit and saves
                // to the new path.
                var readsOther = renamedPhotos.Where(x => x.Result.ReadsOtherSidecar).ToList();
                foreach (var (photo, _) in readsOther)
                    DiscardUnsavedSidecarState(photo!);
                foreach (var (photo, result) in renamedPhotos)
                    ApplyRenameOutcome(photo!, result.NewPath);
                foreach (var (photo, _) in readsOther)
                    ReloadSidecarState(photo!);
                if (!changed)
                    return;
                ApplyFilters();
                Timeline.GroupPhotosByDate(AllPhotos);
            });
        }

        /// <summary>The photo is about to read a sidecar it did not have
        /// (#6072): its unsaved rating and adjustments belong to the old one,
        /// and an autosave would write them over another photo's sidecar. The
        /// flag clears under the gate the autosave takes, so a flush already
        /// waiting on it finds nothing to write.</summary>
        private void DiscardUnsavedSidecarState(PhotoItem photo)
        {
            if (!ReferenceEquals(_openPhoto, photo)) return;
            lock (_localMetadataGate)
            {
                _sidecarDirty = false;
                _localMetadataWrites.Discard(photo.FilePath);
            }
            _sidecarTimer?.Dispose();
            _lastSidecarWriteText = null;
        }

        /// <summary>Loads what the sidecar the renamed photo now reads holds.</summary>
        private void ReloadSidecarState(PhotoItem photo)
        {
            if (ReferenceEquals(_openPhoto, photo) && ReferenceEquals(SelectedPhoto, photo))
            {
                OnSidecarChangedOnDisk(null, SidecarStore.SidecarPathFor(photo.FilePath));
                return;
            }
            var sidecar = SidecarStore.Load(photo.FilePath);
            photo.Rating = sidecar?.Rating ?? 0;
            photo.FlagStatus = sidecar?.Flag ?? "none";
            photo.ColorLabel = sidecar?.ColorLabel;
        }
    }
}
