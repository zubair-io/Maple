using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Maple.WinUI.Services.FileOperations
{
    /// <summary>One folder enumeration, taken the first time a name is asked
    /// for and shared by every check of one relocate plan, so a plan costs one
    /// listing per folder however many checks it makes.</summary>
    internal sealed class FolderListing
    {
        private readonly Lazy<(IReadOnlyList<string> Files, IReadOnlyList<string> Entries)> _names;
        private readonly Lazy<bool> _foldsCase;

        public FolderListing(string directory)
        {
            Directory = directory;
            _names = new Lazy<(IReadOnlyList<string>, IReadOnlyList<string>)>(Load);
            _foldsCase = new Lazy<bool>(() => LocalFileOperations.FolderFoldsCase(
                FileNames.Select(name => Path.Combine(Directory, name)).ToList()));
        }

        public string Directory { get; }

        /// <summary>Regular files only.</summary>
        public IReadOnlyList<string> FileNames => _names.Value.Files;

        /// <summary>Files and folders: everything that holds a name.</summary>
        public IReadOnlyList<string> EntryNames => _names.Value.Entries;

        public bool FoldsCase => _foldsCase.Value;

        private (IReadOnlyList<string>, IReadOnlyList<string>) Load()
        {
            if (!System.IO.Directory.Exists(Directory)) return (Array.Empty<string>(), Array.Empty<string>());
            var infos = new DirectoryInfo(Directory).EnumerateFileSystemInfos().ToList();
            return (
                infos.Where(info => !info.Attributes.HasFlag(FileAttributes.Directory)).Select(info => info.Name).ToList(),
                infos.Select(info => info.Name).ToList());
        }
    }
}
