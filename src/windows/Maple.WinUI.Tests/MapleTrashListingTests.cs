// MapleTrashListingTests — real temp directories, real files. Covers the
// "list what's in Maple's trash" half of #2654's minimal in-app restore
// surface: primary/sidecar pairing, exclusion of orphaned sidecars, the
// relative-path field restore will target, and aggregation across multiple
// open library roots.

using System;
using System.IO;
using System.Linq;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MapleTrashListingTests : IDisposable
    {
        private readonly string _dir;

        public MapleTrashListingTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-trash-listing-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string WriteFile(string root, string relPath, string content)
        {
            var full = Path.Combine(root, relPath);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
            return full;
        }

        [Fact]
        public void ListTrashItemsForRoot_NoTrashFolder_ReturnsEmpty()
        {
            var root = Path.Combine(_dir, "Root");
            Directory.CreateDirectory(root);

            var items = MapleTrashListing.ListTrashItemsForRoot(root);

            Assert.Empty(items);
        }

        [Fact]
        public void ListTrashItemsForRoot_PairsPrimaryWithItsSidecar()
        {
            var root = Path.Combine(_dir, "Root");
            WriteFile(root, Path.Combine(".maple", "trash", "Album", "photo.dng"), "bytes");
            WriteFile(root, Path.Combine(".maple", "trash", "Album", "photo.xmp"), "<xmp/>");

            var items = MapleTrashListing.ListTrashItemsForRoot(root);

            var item = Assert.Single(items);
            Assert.Equal("photo.dng", item.FileName);
            Assert.NotNull(item.TrashSidecarPath);
            Assert.Equal(Path.Combine("Album", "photo.dng"), item.RelativePath);
            Assert.Equal(root, item.LibraryRoot);
        }

        [Fact]
        public void ListTrashItemsForRoot_PrimaryWithNoSidecar_HasNullSidecarPath()
        {
            var root = Path.Combine(_dir, "Root");
            WriteFile(root, Path.Combine(".maple", "trash", "photo.dng"), "bytes");

            var item = Assert.Single(MapleTrashListing.ListTrashItemsForRoot(root));

            Assert.Null(item.TrashSidecarPath);
        }

        [Fact]
        public void ListTrashItemsForRoot_OrphanedSidecarWithNoPrimary_IsExcluded()
        {
            var root = Path.Combine(_dir, "Root");
            WriteFile(root, Path.Combine(".maple", "trash", "orphan.xmp"), "<xmp/>");

            var items = MapleTrashListing.ListTrashItemsForRoot(root);

            Assert.Empty(items);
        }

        [Fact]
        public void ListTrashItems_AggregatesAcrossMultipleLibraryRoots()
        {
            var rootA = Path.Combine(_dir, "RootA");
            var rootB = Path.Combine(_dir, "RootB");
            WriteFile(rootA, Path.Combine(".maple", "trash", "a.dng"), "a");
            WriteFile(rootB, Path.Combine(".maple", "trash", "b.dng"), "b");

            var items = MapleTrashListing.ListTrashItems(new[] { rootA, rootB });

            Assert.Equal(2, items.Count);
            Assert.Contains(items, i => i.FileName == "a.dng" && i.LibraryRoot == rootA);
            Assert.Contains(items, i => i.FileName == "b.dng" && i.LibraryRoot == rootB);
        }

        [Fact]
        public void DisplayLabel_CombinesFileNameAndRelativePath()
        {
            var root = Path.Combine(_dir, "Root");
            WriteFile(root, Path.Combine(".maple", "trash", "Album", "photo.dng"), "bytes");

            var item = Assert.Single(MapleTrashListing.ListTrashItemsForRoot(root));

            Assert.Contains("photo.dng", item.DisplayLabel);
            Assert.Contains(item.RelativePath, item.DisplayLabel);
        }
    }
}
