// RawJpegSharedSidecarFoldTests — a local RAW and JPEG fold into one tile only
// when both read the same sidecar file (#5848). The name rule folds spellings
// that differ in case or Unicode form, but the sidecar path is derived from
// each file's own name, so such a pair can own two different `.xmp` files; a
// trash of the tile would then orphan the JPEG's.

using System;
using System.IO;
using System.Linq;
using System.Text;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RawJpegSharedSidecarFoldTests : IDisposable
    {
        private readonly string _dir;

        public RawJpegSharedSidecarFoldTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-stack-sidecar-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private PhotoItem PhotoOnDisk(string name)
        {
            var path = Path.Combine(_dir, name);
            File.WriteAllText(path, name);
            return new PhotoItem { FilePath = path, FileName = name, Format = Path.GetExtension(name)[1..].ToUpperInvariant() };
        }

        private bool VolumeFoldsCase()
        {
            File.WriteAllText(Path.Combine(_dir, "probe.tmp"), "x");
            return File.Exists(Path.Combine(_dir, "PROBE.TMP"));
        }

        [Fact]
        public void SameSpellingStem_FoldsOnDisk()
        {
            var photos = new[] { PhotoOnDisk("IMG_1.CR3"), PhotoOnDisk("IMG_1.JPG") };

            var tiles = RawJpegStackFold.Apply(photos, stacksPairs: true, requireSharedSidecar: true);

            Assert.Single(tiles);
            Assert.Same(photos[1], photos[0].StackCompanion);
        }

        [Fact]
        public void ComposedAndDecomposedAccents_StayTwoTiles()
        {
            var composed = "Café".Normalize(NormalizationForm.FormC);
            var decomposed = "Café".Normalize(NormalizationForm.FormD);
            Assert.NotEqual(composed, decomposed);
            var photos = new[] { PhotoOnDisk(composed + ".arw"), PhotoOnDisk(decomposed + ".jpg") };

            var tiles = RawJpegStackFold.Apply(photos, stacksPairs: true, requireSharedSidecar: true);

            Assert.Equal(2, tiles.Count);
            Assert.All(photos, photo =>
            {
                Assert.Null(photo.StackCompanion);
                Assert.Null(photo.StackPrimary);
            });
        }

        [Fact]
        public void ComposedAndDecomposedAccents_StillFoldWhereNothingChecksTheSidecar()
        {
            var photos = new[]
            {
                new PhotoItem { FilePath = "/shoot/Café.arw", FileName = "a", Format = "ARW" },
                new PhotoItem { FilePath = "/shoot/Café.jpg", FileName = "b", Format = "JPG" },
            };

            Assert.Single(RawJpegStackFold.Apply(photos, stacksPairs: true));
        }

        [Fact]
        public void NamesDifferingOnlyInCase_FoldExactlyWhereTheFolderFoldsCase()
        {
            var photos = new[] { PhotoOnDisk("IMG_1.CR3"), PhotoOnDisk("img_1.jpg") };

            var tiles = RawJpegStackFold.Apply(photos, stacksPairs: true, requireSharedSidecar: true);

            Assert.Equal(VolumeFoldsCase() ? 1 : 2, tiles.Count);
        }

        private string[] Inventory() => Directory.EnumerateFiles(_dir).ToArray();

        [Fact]
        public void ASecondRawTheGridDoesNotList_KeepsTheStemUnpaired()
        {
            var photos = new[] { PhotoOnDisk("IMG.CR3"), PhotoOnDisk("IMG.JPG") };
            File.WriteAllText(Path.Combine(_dir, "IMG.MEF"), "another raw");

            var tiles = RawJpegStackFold.Apply(photos, stacksPairs: true, requireSharedSidecar: true, inventory: Inventory());

            Assert.Equal(2, tiles.Count);
            Assert.All(photos, photo => Assert.Null(photo.StackCompanion));
            Assert.All(photos, photo => Assert.Null(photo.StackPrimary));
        }

        [Fact]
        public void AnUnrelatedMefInTheFolder_DoesNotStopAnotherStemFolding()
        {
            var photos = new[] { PhotoOnDisk("IMG.CR3"), PhotoOnDisk("IMG.JPG") };
            File.WriteAllText(Path.Combine(_dir, "OTHER.MEF"), "unrelated");

            var tiles = RawJpegStackFold.Apply(photos, stacksPairs: true, requireSharedSidecar: true, inventory: Inventory());

            Assert.Single(tiles);
            Assert.Same(photos[1], photos[0].StackCompanion);
        }

        [Fact]
        public void WithoutAnInventory_TheDisplayedFilesDecideAsBefore()
        {
            var photos = new[] { PhotoOnDisk("IMG.CR3"), PhotoOnDisk("IMG.JPG") };

            Assert.Single(RawJpegStackFold.Apply(photos, stacksPairs: true, requireSharedSidecar: true));
        }

        [Fact]
        public void PairingOverAGivenInventory_TouchesNoFile()
        {
            var inventory = new[] { "/does/not/exist/IMG_1.CR3", "/does/not/exist/img_1.jpg", "/does/not/exist/IMG_2.CR3", "/does/not/exist/IMG_2.JPG" };

            var folding = RawJpegPairing.LocalPairs(inventory, folderFoldsCase: true);
            var caseSensitive = RawJpegPairing.LocalPairs(inventory, folderFoldsCase: false);

            Assert.Equal(2, folding.Count);
            Assert.Equal(new[] { "/does/not/exist/IMG_2.CR3" }, caseSensitive.Keys);
        }

        [Fact]
        public void ComposedAndDecomposedAccents_StayTwoTiles_WhateverTheFolderFoldsCase()
        {
            var composed = "Caf\u00e9".Normalize(NormalizationForm.FormC);
            var decomposed = "Caf\u00e9".Normalize(NormalizationForm.FormD);
            var inventory = new[] { $"/x/{composed}.arw", $"/x/{decomposed}.jpg" };

            Assert.Empty(RawJpegPairing.LocalPairs(inventory, folderFoldsCase: true));
            Assert.Empty(RawJpegPairing.LocalPairs(inventory, folderFoldsCase: false));
        }

        [Fact]
        public void AFewHundredMixedCasePairs_FoldWithoutScanningTheFolderPerPair()
        {
            var inventory = Enumerable.Range(0, 400)
                .SelectMany(i => new[] { $"/shoot/IMG_{i}.CR3", $"/shoot/img_{i}.jpg" }).ToList();
            var photos = inventory.Select(path => new PhotoItem
            {
                FilePath = path, FileName = Path.GetFileName(path), Format = Path.GetExtension(path)[1..].ToUpperInvariant(),
            }).ToList();

            var clock = System.Diagnostics.Stopwatch.StartNew();
            var tiles = RawJpegStackFold.Apply(photos, true, true, inventory, folderFoldsCase: true);
            clock.Stop();

            Assert.Equal(400, tiles.Count);
            Assert.True(clock.ElapsedMilliseconds < 2000, $"took {clock.ElapsedMilliseconds} ms");
        }

        [Fact]
        public void TheFoldersCaseBehaviourIsDecidedFromTheInventoryWithOneProbe()
        {
            var raw = Path.Combine(_dir, "IMG.CR3");
            File.WriteAllText(raw, "x");

            var folds = LocalFileOperations.FolderFoldsCase(new[] { raw });

            Assert.Equal(File.Exists(Path.Combine(_dir, "img.cr3")), folds);
            Assert.False(LocalFileOperations.FolderFoldsCase(new[] { raw, Path.Combine(_dir, "img.cr3") }));
        }
    }
}
