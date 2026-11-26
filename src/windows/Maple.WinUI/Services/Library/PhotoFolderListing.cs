using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI.Services
{
    internal sealed record PhotoFolderListing(
        List<string> Images,
        List<string> PairInventory,
        bool Complete,
        bool FoldsCase,
        IReadOnlyDictionary<string, FileInfo> Entries)
    {
        public static PhotoFolderListing Read(string folderPath, IReadOnlySet<string> supportedExtensions)
        {
            try
            {
                var entries = new Dictionary<string, FileInfo>(StringComparer.Ordinal);
                foreach (var file in new DirectoryInfo(folderPath).GetFiles())
                    entries[file.Name] = file;
                var paths = entries.Keys.Select(name => Path.Combine(folderPath, name)).ToList();
                var pairInventory = paths.Where(RawJpegPairing.IsPairCandidate).ToList();
                return new PhotoFolderListing(
                    paths.Where(path => supportedExtensions.Contains(Path.GetExtension(path)))
                        .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                        .ToList(),
                    pairInventory, Complete: true,
                    FoldsCase: LocalFileOperations.FolderFoldsCase(pairInventory),
                    entries);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return new PhotoFolderListing(
                    new List<string>(), new List<string>(), Complete: false, FoldsCase: false,
                    new Dictionary<string, FileInfo>());
            }
        }
    }
}
