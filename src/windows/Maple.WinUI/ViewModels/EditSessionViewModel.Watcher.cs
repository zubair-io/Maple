// EditSessionViewModel.Watcher.cs — live grid updates for the browsed
// folder (#2585): new files join the grid (sorted, hydrated), deleted files
// leave it. Split out of EditSessionViewModel.Library.cs (#2754) to
// stay under this codebase's line-budget after the #2651
// drop-to-mount additions — same reasoning as that file's own prior split
// note (#2639) and EditSessionViewModel.DropMount.cs's.

using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services;
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
                        _ = Task.Run(() => HydrateLibraryAsync(items, CancellationToken.None));
                });
            };
            return watcher;
        }
    }
}
