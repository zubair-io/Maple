using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI.Services
{
    internal sealed class LocalFolderScan
    {
        public static readonly LocalFolderScan Default = new(SidecarStore.LoadWhenPresent);

        private readonly Func<string, XmpSidecarDocument?> _loadSidecar;

        public LocalFolderScan(Func<string, XmpSidecarDocument?> loadSidecar) => _loadSidecar = loadSidecar;

        public List<PhotoItem> Scan(PhotoFolderListing listing, CancellationToken ct)
        {
            var presentNames = new HashSet<string>(listing.Entries.Keys, StringComparer.OrdinalIgnoreCase);
            var items = new List<PhotoItem>(listing.Images.Count);
            foreach (var filePath in listing.Images)
            {
                if (ct.IsCancellationRequested)
                    break;
                var info = listing.Entries[Path.GetFileName(filePath)];
                var item = new PhotoItem
                {
                    FilePath = filePath,
                    FileName = info.Name,
                    Format = info.Extension.TrimStart('.').ToUpperInvariant(),
                    FileSizeBytes = info.Length,
                    FileModifiedUtc = info.LastWriteTimeUtc,
                };
                var sidecarName = Path.GetFileName(SidecarStore.SidecarPathFor(filePath));
                // A sidecar the listing names may have vanished since; LoadWhenPresent then reads it as absent.
                if (presentNames.Contains(sidecarName) && _loadSidecar(filePath) is { } sidecar)
                {
                    item.Rating = sidecar.Rating ?? 0;
                    item.FlagStatus = sidecar.Flag ?? "none";
                    item.ColorLabel = sidecar.ColorLabel;
                }
                items.Add(item);
            }
            return items;
        }
    }
}
