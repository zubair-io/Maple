// RawJpegPairInventoryWatcherTests — a RAW format the grid does not show
// (IMG.MEF) never becomes a tile, but its arrival, removal or rename must
// reach the pair decision (#5848). Real temp folder and a real
// FileSystemWatcher; the fold decision itself is WinUI-free.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
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

        private static async Task<bool> UntilAsync(Func<bool> condition)
        {
            var deadline = Environment.TickCount64 + 8000;
            while (!condition() && Environment.TickCount64 < deadline) await Task.Delay(50);
            return condition();
        }

        [Fact]
        public async Task AMefArrivingRemainingAndLeaving_ReachesTheInventoryButNeverTheGrid()
        {
            var shown = new List<string>();
            using var watcher = Watcher(shown, out var events);
            watcher.Watch(_dir);
            var mef = Path.Combine(_dir, "IMG.MEF");

            File.WriteAllText(mef, "raw");
            Assert.True(await UntilAsync(() => events() >= 1));
            var afterAdd = events();
            File.Move(mef, Path.Combine(_dir, "IMG2.MEF"));
            Assert.True(await UntilAsync(() => events() > afterAdd));
            var afterRename = events();
            File.Delete(Path.Combine(_dir, "IMG2.MEF"));
            Assert.True(await UntilAsync(() => events() > afterRename));

            Assert.Empty(shown);
        }

        [Fact]
        public async Task ADisplayedFile_StillArrivesAsATile()
        {
            var shown = new List<string>();
            using var watcher = Watcher(shown, out _);
            watcher.Watch(_dir);

            File.WriteAllText(Path.Combine(_dir, "IMG.CR3"), "raw");

            Assert.True(await UntilAsync(() => { lock (shown) return shown.Count == 1; }));
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
