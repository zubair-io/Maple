// RawJpegPairInventoryWatcherTests — a RAW format the grid does not show
// (IMG.MEF) never becomes a tile, but its arrival, removal or rename must
// reach the pair decision (#5848). Real temp folder and a real
// FileSystemWatcher; the fold decision itself is WinUI-free.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RawJpegPairInventoryWatcherTests : IDisposable
    {
        private static readonly HashSet<string> Displayed = new(StringComparer.OrdinalIgnoreCase) { ".cr3", ".jpg" };
        private readonly string _dir;

        public RawJpegPairInventoryWatcherTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-pair-watcher-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private LibraryWatcher Watcher(List<string> shown, out Func<int> events)
        {
            var count = 0;
            events = () => count;
            var watcher = new LibraryWatcher(path => Displayed.Contains(Path.GetExtension(path)), RawJpegPairing.IsPairCandidate);
            watcher.ChangesReady += (added, _) => { lock (shown) shown.AddRange(added); };
            watcher.PairInventoryChanged += () => System.Threading.Interlocked.Increment(ref count);
            return watcher;
        }

        [Fact]
        public void AMefArrivingRemainingAndLeaving_ReachesTheInventoryButNeverTheGrid()
        {
            var shown = new List<string>();
            using var watcher = Watcher(shown, out var events);
            var mef = Path.Combine(_dir, "IMG.MEF");
            var renamed = Path.Combine(_dir, "IMG2.MEF");

            File.WriteAllText(mef, "raw");
            watcher.QueueAdded(mef);
            watcher.Flush();
            Assert.Equal(1, events());

            File.Move(mef, renamed);
            watcher.QueueRenamed(mef, renamed);
            watcher.Flush();
            Assert.Equal(2, events());

            File.Delete(renamed);
            watcher.QueueRemoved(renamed);
            watcher.Flush();
            Assert.Equal(3, events());
            Assert.Empty(shown);
        }

        [Fact]
        public void ADisplayedFile_StillArrivesAsATile_WithoutAnInventoryEvent()
        {
            var shown = new List<string>();
            using var watcher = Watcher(shown, out var events);
            var raw = Path.Combine(_dir, "IMG.CR3");

            File.WriteAllText(raw, "raw");
            watcher.QueueAdded(raw);
            watcher.Flush();

            Assert.Equal(new[] { raw }, shown);
            Assert.Equal(0, events());
        }

        [Fact]
        public void ADisplayedRawRenamedToAMef_LeavesTheGridAndReachesTheInventory()
        {
            var shown = new List<string>();
            var removed = new List<string>();
            using var watcher = Watcher(shown, out var events);
            watcher.ChangesReady += (_, gone) => removed.AddRange(gone);
            var cr3 = Path.Combine(_dir, "IMG.CR3");
            var mef = Path.Combine(_dir, "IMG.MEF");
            File.WriteAllText(mef, "raw");

            watcher.QueueRenamed(cr3, mef);
            watcher.Flush();

            Assert.Equal(new[] { cr3 }, removed);
            Assert.Empty(shown);
            Assert.Equal(1, events());
        }

        private static PhotoItem Photo(string path) => new()
        {
            FilePath = path,
            FileName = Path.GetFileName(path),
            Format = Path.GetExtension(path)[1..].ToUpperInvariant(),
        };

        [Fact]
        public void AddingAMef_UnfoldsTheStack_AndRemovingItFoldsAgain()
        {
            var photos = new[] { Photo(Path.Combine(_dir, "IMG.CR3")), Photo(Path.Combine(_dir, "IMG.JPG")) };
            foreach (var photo in photos) File.WriteAllText(photo.FilePath, "x");
            var mef = Path.Combine(_dir, "IMG.MEF");

            var folded = RawJpegStackFold.Apply(photos, true, true, Directory.EnumerateFiles(_dir));
            File.WriteAllText(mef, "x");
            var ambiguous = RawJpegStackFold.Apply(photos, true, true, Directory.EnumerateFiles(_dir));
            File.Delete(mef);
            var refolded = RawJpegStackFold.Apply(photos, true, true, Directory.EnumerateFiles(_dir));

            Assert.Single(folded);
            Assert.Equal(2, ambiguous.Count);
            Assert.Single(refolded);
        }

        [Fact]
        public void RenamingOneHalfOfAFoldedPair_ShowsBothTiles()
        {
            var raw = Photo(Path.Combine(_dir, "IMG.CR3"));
            var jpeg = Photo(Path.Combine(_dir, "IMG.JPG"));
            File.WriteAllText(raw.FilePath, "x");
            File.WriteAllText(jpeg.FilePath, "x");
            Assert.Single(RawJpegStackFold.Apply(new[] { raw, jpeg }, true, true, Directory.EnumerateFiles(_dir)));

            File.Move(jpeg.FilePath, Path.Combine(_dir, "Other.JPG"));
            var renamed = new PhotoItem { FilePath = Path.Combine(_dir, "Other.JPG"), FileName = "Other.JPG", Format = "JPG" };
            var tiles = RawJpegStackFold.Apply(new[] { raw, renamed }, true, true, Directory.EnumerateFiles(_dir));

            Assert.Equal(2, tiles.Count);
            Assert.Null(raw.StackCompanion);
        }
    }
}
